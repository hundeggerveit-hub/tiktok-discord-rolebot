// TikTok → Discord Rollenbot mit 7-Tage-Rollen-Timeout + Retroaktiv

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Events, PermissionsBitField } = require('discord.js');
const { WebcastPushConnection } = require('tiktok-live-connector');

// ====== ENV ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_ID = process.env.DISCORD_ROLE_ID;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME; // ohne @
const GIFT_NAMES = (process.env.GIFT_NAMES || 'Teamherz').split(',').map(s => s.trim().toLowerCase());

if (!DISCORD_TOKEN || !GUILD_ID || !ROLE_ID || !TIKTOK_USERNAME) {
  console.error('❌ Fehlende ENV Variablen. Bitte .env ausfüllen.');
  process.exit(1);
}

// ====== Persistente Speicherung ======
const DATA_DIR = path.join(__dirname, 'data');
const LINKS_FILE = path.join(DATA_DIR, 'links.json'); // TikTokName -> DiscordUserId
const ROLE_TIMERS_FILE = path.join(DATA_DIR, 'role_timers.json'); // TikTokName -> timestamp

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  if (!fs.existsSync(LINKS_FILE)) fs.writeFileSync(LINKS_FILE, JSON.stringify({}, null, 2));
  if (!fs.existsSync(ROLE_TIMERS_FILE)) fs.writeFileSync(ROLE_TIMERS_FILE, JSON.stringify({}, null, 2));
}

function loadLinks() {
  ensureStorage();
  try {
    return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  } catch (e) {
    console.error('⚠️ Konnte links.json nicht lesen. Setze leeres Mapping.', e);
    return {};
  }
}
function saveLinks(obj) {
  ensureStorage();
  fs.writeFileSync(LINKS_FILE, JSON.stringify(obj, null, 2));
}

function loadRoleTimers() {
  ensureStorage();
  try {
    return JSON.parse(fs.readFileSync(ROLE_TIMERS_FILE, 'utf8'));
  } catch (e) {
    console.error('⚠️ Konnte role_timers.json nicht lesen. Setze leeres Mapping.', e);
    return {};
  }
}
function saveRoleTimers(obj) {
  ensureStorage();
  fs.writeFileSync(ROLE_TIMERS_FILE, JSON.stringify(obj, null, 2));
}

let links = loadLinks();
let roleTimers = loadRoleTimers();

// ====== Discord Client ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.GuildMember, Partials.User]
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const role = await guild.roles.fetch(ROLE_ID);
    if (!role) console.warn('⚠️ Rolle nicht gefunden. Prüfe DISCORD_ROLE_ID.');
    console.log(`🛠️  Zielrolle: ${role ? role.name : ROLE_ID}`);

    const me = await guild.members.fetchMe();
    const canManageRoles = me.permissions.has(PermissionsBitField.Flags.ManageRoles);
    if (!canManageRoles) console.warn('⚠️ Bot hat kein Manage Roles-Recht!');
  } catch (e) {
    console.error('❌ Konnte Guild/Rolle nicht prüfen:', e.message);
  }
});

// ====== Text-Commands ======
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.guild || msg.guild.id !== GUILD_ID) return;

  const content = msg.content.trim();
  if (content.startsWith('!verify ')) {
    const tikTokName = content.split(/\s+/)[1];
    if (!tikTokName) return msg.reply('Usage: `!verify <TikTokName>`');

    links[tikTokName] = msg.author.id;
    saveLinks(links);
    msg.reply(`✅ Verknüpft: **${tikTokName}** ↔ <@${msg.author.id}>`);

    // ---- Retroaktiv: Rolle direkt vergeben, falls Timer existiert ----
    if (roleTimers[tikTokName]) {
      try {
        await grantRoleByDiscordId(msg.author.id, 'Retroaktiv: Teamherz bereits gesendet');
        msg.reply(`🎉 Rolle retroaktiv vergeben, da bereits ein Teamherz gesendet wurde.`);
      } catch (e) {
        console.error('Retroaktiv Rolle vergeben Fehler:', e.message);
      }
    }
    // ----------------------------------------------------------
    
    return;
  }

  if (content === '!unlink') {
    const entry = Object.entries(links).find(([, discordId]) => discordId === msg.author.id);
    if (!entry) return msg.reply('Du hast aktuell keinen gespeicherten TikTok‑Namen.');
    const [tikName] = entry;
    delete links[tikName];
    saveLinks(links);
    return msg.reply(`🗑️ Verknüpfung entfernt: **${tikName}**`);
  }

  if (content === '!whoami') {
    const entry = Object.entries(links).find(([, discordId]) => discordId === msg.author.id);
    if (!entry) return msg.reply('Kein TikTok‑Name gespeichert. Nutze `!verify <TikTokName>`.');
    const [tikName] = entry;
    return msg.reply(`Du bist verknüpft als **${tikName}**.`);
  }
});

// ====== Rolle vergeben Helper ======
async function grantRoleByDiscordId(discordUserId, reason) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.add(ROLE_ID, reason);
    console.log(`🎉 Rolle an ${member.user.tag} vergeben (${reason})`);
  } catch (e) {
    console.error(`❌ Konnte Rolle nicht vergeben an ${discordUserId}:`, e.message);
  }
}

// ====== Rollen Ablauf prüfen ======
async function checkExpiredRoles() {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  for (const [tikTokUser, lastGiftTime] of Object.entries(roleTimers)) {
    if (now - lastGiftTime >= sevenDays) {
      const discordId = links[tikTokUser];
      if (!discordId) continue;

      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(discordId);
        await member.roles.remove(ROLE_ID, '7 Tage kein Teamherz gesendet');
        console.log(`🗑️ Rolle entfernt von ${member.user.tag} (7 Tage kein Gift)`);
        delete roleTimers[tikTokUser];
        saveRoleTimers(roleTimers);
      } catch (e) {
        console.error(`❌ Konnte Rolle nicht entfernen von ${discordId}:`, e.message);
      }
    }
  }
}

// Periodisch jede Stunde prüfen
setInterval(checkExpiredRoles, 60 * 60 * 1000);

// ====== TikTok Live Connection ======
const tiktok = new WebcastPushConnection(TIKTOK_USERNAME);

tiktok.on('gift', async (data) => {
  try {
    const giftName = (data.giftName || '').toLowerCase();
    if (data.repeatEnd && GIFT_NAMES.includes(giftName)) {
      const tikUser = data.uniqueId;
      console.log(`💝 ${tikUser} hat Gift gesendet: ${data.giftName}`);

      const discordId = links[tikUser];
      if (!discordId) {
        console.log(`⚠️ Kein Link für TikTok‑User ${tikUser}.`);
        return;
      }

      // Rolle vergeben und Timer setzen
      await grantRoleByDiscordId(discordId, `Gift: ${data.giftName}`);
      roleTimers[tikUser] = Date.now();
      saveRoleTimers(roleTimers);
    }
  } catch (e) {
    console.error('gift handler error:', e.message);
  }
});

tiktok.on('subscribe', async (data) => {
  try {
    const tikUser = data.uniqueId;
    console.log(`⭐ Mitglied/Subscriber erkannt: ${tikUser}`);

    const discordId = links[tikUser];
    if (!discordId) {
      console.log(`⚠️ Kein Link für TikTok‑User ${tikUser}.`);
      return;
    }
    await grantRoleByDiscordId(discordId, 'TikTok Mitglied');
  } catch (e) {
    console.error('subscribe handler error:', e.message);
  }
});

// TikTok verbinden
tiktok.connect()
  .then(state => console.log(`📡 Verbunden mit TikTok Live von @${TIKTOK_USERNAME}`))
  .catch(err => console.error('❌ TikTok Connect Fehler:', err.message));

// Discord Login
client.login(DISCORD_TOKEN).catch(e => {
  console.error('❌ Discord Login Fehler:', e.message);
  process.exit(1);
});
