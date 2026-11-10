// تخزين التدفقات (Blobs) في Turso — كتابة/قراءة الأجزاء وتجميع الملفات
const { LIMITS } = require("./http");

const OUTPUT_CHUNK_SIZE = 2 * 1024 * 1024; // 2 ميغابايت لكل جزء من الناتج

/** كتابة ملف ناتج إلى Turso على شكل أجزاء */
async function saveOutput(jobId, buffer) {
  const { withDb } = require("./turso");
  let chunkCount = 0;
  await withDb(async (db) => {
    await db.execute({ sql: "DELETE FROM merger_output WHERE job_id = ?", args: [jobId] });
    chunkCount = Math.ceil(buffer.length / OUTPUT_CHUNK_SIZE);
    for (let i = 0; i < chunkCount; i++) {
      const slice = buffer.subarray(i * OUTPUT_CHUNK_SIZE, Math.min((i + 1) * OUTPUT_CHUNK_SIZE, buffer.length));
      await db.execute({
        sql: "INSERT INTO merger_output (job_id, chunk, data) VALUES (?, ?, ?)",
        args: [jobId, i, slice],
      });
    }
  });
  return chunkCount;
}

/** قراءة الناتج كاملاً (أو مجال بايتات) من Turso — يدعم Range */
async function readOutput(jobId, start = null, end = null) {
  const { withDb } = require("./turso");
  return withDb(async (db) => {
    const rows = await db.execute({
      sql: "SELECT chunk, data FROM merger_output WHERE job_id = ? ORDER BY chunk ASC",
      args: [jobId],
    });
    if (!rows.rows.length) return null;
    const buffers = [];
    let offsets = [];
    let offset = 0;
    for (const r of rows.rows) {
      const buf = Buffer.from(r.data);
      buffers.push(buf);
      offsets.push({ start: offset, end: offset + buf.length - 1 });
      offset += buf.length;
    }
    const total = offset;
    const s = start === null ? 0 : Math.max(0, Math.min(start, total - 1));
    const e = end === null ? total - 1 : Math.min(end, total - 1);
    const parts = [];
    for (let i = 0; i < buffers.length; i++) {
      const o = offsets[i];
      if (o.end < s || o.start > e) continue;
      const from = Math.max(0, s - o.start);
      const to = Math.min(buffers[i].length - 1, e - o.start);
      parts.push(buffers[i].subarray(from, to + 1));
    }
    return { buffer: Buffer.concat(parts), total };
  });
}

/** تجميع ملف مصدر مرفوع (أجزاء) إلى /tmp */
async function assembleSourceFile(jobId, seq, destPath, expectedSize) {
  const { withDb } = require("./turso");
  const fs = require("fs");
  return withDb(async (db) => {
    const rows = await db.execute({
      sql: "SELECT chunk, data FROM merger_chunks WHERE job_id = ? AND seq = ? ORDER BY chunk ASC",
      args: [jobId, seq],
    });
    const ws = fs.createWriteStream(destPath);
    let received = 0;
    for (const r of rows.rows) {
      const buf = Buffer.from(r.data);
      received += buf.length;
      if (received > expectedSize + 1024 * 1024) {
        throw new Error("حجم الملف المرفوع أكبر من المعلن");
      }
      ws.write(buf);
    }
    await new Promise((resolve) => ws.end(resolve));
    return received;
  });
}

/** عدد البايتات المستلمة لمصدر مرفوع */
async function receivedBytes(jobId, seq) {
  const { withDb } = require("./turso");
  return withDb(async (db) => {
    const rows = await db.execute({
      sql: "SELECT COALESCE(SUM(length(data)), 0) AS total FROM merger_chunks WHERE job_id = ? AND seq = ?",
      args: [jobId, seq],
    });
    return Number(rows.rows[0].total ?? 0);
  });
}

module.exports = { saveOutput, readOutput, assembleSourceFile, receivedBytes, OUTPUT_CHUNK_SIZE, LIMITS };
