// طبقة Turso لخدمة الدمج — جداول مستقلة (merger_*) داخل نفس قاعدة البيانات المشتركة
// كل شيء مخزّن هنا: بيانات المهام + أجزاء الملفات المصدرية + الفيديو الناتج (Blobs) — بلا S3 أو خدمات خارجية
const { createClient } = require("@libsql/client");

let client = null;
let schemaPromise = null;

function getDb() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error("TURSO_DATABASE_URL مفقود");
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  }
  return client;
}

function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`CREATE TABLE IF NOT EXISTS merger_jobs (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        sources_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS merger_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, chunk)
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS merger_output (
        job_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, chunk)
      )`);
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

async function withDb(fn) {
  await ensureSchema();
  return fn(getDb());
}

module.exports = { getDb, ensureSchema, withDb };
