// init.js
const { Client } = require('pg');
require('dotenv').config();

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function init() {
  await db.connect();
  console.log("⏳ Tabellen werden erstellt…");

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

  console.log("✅ Tabellen erstellt!");
  await db.end();
}

init().catch(err => {
  console.error("❌ Fehler beim Erstellen der Tabellen:", err);
  db.end();
});
