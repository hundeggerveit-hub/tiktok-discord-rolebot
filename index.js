// TikTok → Discord Rollenbot mit 7-Tage-Rollen-Timeout + Retroaktiv + DB + Webserver

require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, Partials, Events, PermissionsBitField } = require('discord.js');
const { WebcastPushConnection } = require('tiktok-live-connector');
const { Client: PgClient } = require('pg');

// ====== ENV ======
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const ROLE_ID = process.env.DISCORD_ROLE_ID;
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME; // ohne @
const GIFT_NAMES = (process.env.GIFT_NAMES || 'Teamherz').split(',').map(s => s.trim().toLowerCase());
const DATABASE_URL = process.env.DATABASE_URL;

if (!DISCORD_TOKEN || !GUILD_ID || !ROLE_ID || !TIKTOK_USERNAME) {
  console.error('❌ Fehlende ENV Variablen. Bitte .env ausfüllen.');
  process.exit(1);
}

// ====== Postgres DB Verbindung ======
const db = new PgClient({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false } // wichtig für Render
});

db.connect()
  .then(() => console.log("✅ Mit Postgres verbunden"))
  .catch(err => console.error("❌ DB Fehler:", err));

// ====== Tabellen sicherstellen ======
async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS links (
      tiktok_username TEXT PRIMARY KEY,
      discord_id TEXT NOT NULL
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS role_timers (
      tiktok_username TEXT PRIMARY KEY,
      last_gift_time BIGINT NOT NULL
    );
  `);
}
initDB().catch(console.error);

// ====== Webserver ======
const app = express();
const port = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("Bot läuft!"));
app.listen(port, () => console.log(`🌐 Webserver läuft auf Port ${port}`));

// ====== Discord Client ======
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.GuildMember, Partials.User]
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Eingeloggt als ${client.user.tag}`);
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const role = await guild.roles.fetch(ROLE_ID);
    if (!role) console.warn('⚠️ Rolle nicht gefunden. Prüfe DISCORD_ROLE_ID.');
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      console.warn('⚠️ Bot hat kein Manage Roles-Recht!');
    }
  } catch (e) { console.error('❌ Konnte Guild/Rolle nicht prüfen:', e.message); }
});

// ====== Helper: Rolle vergeben ======
async function grantRoleByDiscordId(discordUserId, reason) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.add(ROLE_ID, reason);
    console.log(`🎉 Rolle an ${member.user.tag} vergeben (${reason})`);
  } catch (e) { console.error(`❌ Konnte Rolle nicht vergeben an ${discordUserId}:`, e.message); }
}

// ====== Helper: Rolle entfernen ======
async function removeRoleByDiscordId(discordUserId, reason) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.remove(ROLE_ID, reason);
    console.log(`🗑️ Rolle entfernt von ${member.user.tag} (${reason})`);
  } catch (e) { console.error(`❌ Konnte Rolle nicht entfernen von ${discordUserId}:`, e.message); }
}

// ====== Text-Commands ======
client.on(Events.MessageCreate, async msg => {
  if (msg.author.bot || !msg.guild || msg.guild.id !== GUILD_ID) return;
  const content = msg.content.trim();

  // ---- !verify <TikTokName> ----
  if (content.startsWith('!verify ')) {
    const tikTokName = content.split(/\s+/)[1];
    if (!tikTokName) return msg.reply('Usage: `!verify <TikTokName>`');

    await db.query(`
      INSERT INTO links (tiktok_username, discord_id)
      VALUES ($1, $2)
      ON CONFLICT (tiktok_username) DO UPDATE
      SET discord_id = EXCLUDED.discord_id;
    `, [tikTokName, msg.author.id]);

    msg.reply(`✅ Verknüpft: **${tikTokName}** ↔ <@${msg.author.id}>`);

    // Retroaktiv Rolle vergeben, falls Timer existiert
    const res = await db.query('SELECT last_gift_time FROM role_timers WHERE tiktok_username = $1', [tikTokName]);
    if (res.rows.length > 0) {
      await grantRoleByDiscordId(msg.author.id, 'Retroaktiv: Teamherz bereits gesendet');
      msg.reply('🎉 Rolle retroaktiv vergeben, da bereits ein Teamherz gesendet wurde.');
    }
    return;
  }

  // ---- !unlink ----
  if (content === '!unlink') {
    const res = await db.query('SELECT tiktok_username FROM links WHERE discord_id = $1', [msg.author.id]);
    if (res.rows.length === 0) return msg.reply('Du hast aktuell keinen gespeicherten TikTok‑Namen.');
    const tikName = res.rows[0].tiktok_username;

    await db.query('DELETE FROM links WHERE tiktok_username = $1', [tikName]);
    msg.reply(`🗑️ Verknüpfung entfernt: **${tikName}**`);

    // Optional: Rolle entfernen, Timer bleibt für DB-Historie
    await removeRoleByDiscordId(msg.author.id, 'Verknüpfung entfernt');
    return;
  }

  // ---- !whoami ----
  if (content === '!whoami') {
    const res = await db.query('SELECT tiktok_username FROM links WHERE discord_id = $1', [msg.author.id]);
    if (res.rows.length === 0) return msg.reply('Kein TikTok‑Name gespeichert. Nutze `!verify <TikTokName>`.');
    const tikName = res.rows[0].tiktok_username;
    return msg.reply(`Du bist verknüpft als **${tikName}**.`);
  }
});

// ====== Rollen Ablauf prüfen (7 Tage Inaktivität) ======
async function checkExpiredRoles() {
  const now = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;

  const res = await db.query('SELECT tiktok_username, last_gift_time FROM role_timers');
  for (const row of res.rows) {
    if (now - row.last_gift_time >= sevenDays) {
      // Rolle entfernen
      const linkRes = await db.query('SELECT discord_id FROM links WHERE tiktok_username = $1', [row.tiktok_username]);
      if (linkRes.rows.length === 0) continue;
      const discordId = linkRes.rows[0].discord_id;

      await removeRoleByDiscordId(discordId, '7 Tage kein Teamherz gesendet');

      // Timer aus DB löschen, Link bleibt bestehen
      await db.query('DELETE FROM role_timers WHERE tiktok_username = $1', [row.tiktok_username]);
    }
  }
}
setInterval(checkExpiredRoles, 60 * 60 * 1000); // jede Stunde prüfen

// ====== TikTok Live Connection ======
const tiktok = new WebcastPushConnection(TIKTOK_USERNAME);

tiktok.on('gift', async data => {
  try {
    const giftName = (data.giftName || '').toLowerCase();
    if (data.repeatEnd && GIFT_NAMES.includes(giftName)) {
      const tikUser = data.uniqueId;
      console.log(`💝 ${tikUser} hat Gift gesendet: ${data.giftName}`);

      const linkRes = await db.query('SELECT discord_id FROM links WHERE tiktok_username = $1', [tikUser]);
      if (linkRes.rows.length === 0) return console.log(`⚠️ Kein Link für TikTok‑User ${tikUser}.`);
      const discordId = linkRes.rows[0].discord_id;

      // Rolle vergeben
      await grantRoleByDiscordId(discordId, `Gift: ${data.giftName}`);

      // Timer updaten oder neu erstellen
      await db.query(`
        INSERT INTO role_timers (tiktok_username, last_gift_time)
        VALUES ($1, $2)
        ON CONFLICT (tiktok_username) DO UPDATE
        SET last_gift_time = EXCLUDED.last_gift_time;
      `, [tikUser, Date.now()]);
    }
  } catch (e) { console.error('gift handler error:', e.message); }
});

tiktok.on('subscribe', async data => {
  try {
    const tikUser = data.uniqueId;
    console.log(`⭐ Mitglied/Subscriber erkannt: ${tikUser}`);

    const linkRes = await db.query('SELECT discord_id FROM links WHERE tiktok_username = $1', [tikUser]);
    if (linkRes.rows.length === 0) return console.log(`⚠️ Kein Link für TikTok‑User ${tikUser}.`);
    const discordId = linkRes.rows[0].discord_id;

    await grantRoleByDiscordId(discordId, 'TikTok Mitglied');
  } catch (e) { console.error('subscribe handler error:', e.message); }
});

tiktok.connect()
  .then(() => console.log(`📡 Verbunden mit TikTok Live von @${TIKTOK_USERNAME}`))
  .catch(err => console.error('❌ TikTok Connect Fehler:', err.message));

// ====== Discord Login ======
client.login(DISCORD_TOKEN).catch(e => {
  console.error('❌ Discord Login Fehler:', e.message);
  process.exit(1);
});

module.exports = { db };
