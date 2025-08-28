const { Client } = require('pg');
require('dotenv').config();

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function showLinks() {
  await db.connect();
  const res = await db.query('SELECT * FROM links');
  console.log(res.rows); // zeigt alle Einträge
  await db.end();
}

showLinks().catch(console.error);
