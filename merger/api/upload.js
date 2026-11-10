// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ملف مصدري (ثنائي ≤4 ميغابايت)
// عند اكتمال حجم المصدر المعلن: يجعل المصدر جاهزًا، وعند اكتمال كل المصادر: status=queued
const { LIMITS, sendJson, sendError, readRawBody } = require("../lib/http");
const { withDb, getDb } = require("../lib/turso");
const { receivedBytes } = require("../lib/store");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم POST لرفع الأجزاء");
    return;
  }

  const job = String(req.query.job || "");
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!job || !Number.isInteger(seq) || seq < 0 || !Number.isInteger(chunk) || chunk < 0) {
    return sendError(res, 400, "معاملات job و seq و chunk مطلوبة وصحيحة");
  }

  let body;
  try {
    body = await readRawBody(req, LIMITS.uploadChunkBytes + 512 * 1024);
  } catch (e) {
    if (e && e.tooLarge) return sendError(res, 413, `حجم الجزء يتجاوز ${Math.round(LIMITS.uploadChunkBytes / 1048576)} ميغابايت`);
    return sendError(res, 400, "تعذر قراءة الجسم الثنائي");
  }
  if (!body.length) return sendError(res, 400, "الجزء فارغ");

  try {
    const db = getDb();
    await require("../lib/turso").ensureSchema();
    const rows = await db.execute({ sql: "SELECT * FROM merger_jobs WHERE id = ?", args: [job] });
    if (!rows.rows.length) return sendError(res, 404, "المهمة غير موجودة");
    const jobRow = rows.rows[0];
    if (["done", "failed", "processing"].includes(String(jobRow.status))) {
      return sendError(res, 409, `لا يمكن الرفع في حالة المهمة الحالية: ${jobRow.status}`);
    }

    const sources = JSON.parse(jobRow.sources_json);
    if (!sources[seq]) return sendError(res, 404, "المصدر المطلوب غير موجود في هذه المهمة");
    if (sources[seq].kind !== "file") {
      return sendError(res, 400, "هذا المصدر رابط URL — لا يحتاج رفع أجزاء");
    }

    // التحقق من تسلسل الجزء (حفظ الأجزاء المتسلسلة — إعادة الرفع تستبدل الجزء)
    await db.execute({
      sql: "INSERT INTO merger_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, seq, chunk) DO UPDATE SET data = excluded.data",
      args: [job, seq, chunk, body],
    });

    // هل اكتمل المصدر؟
    const received = await receivedBytes(job, seq);
    const expected = Number(sources[seq].size || 0);
    let sourceComplete = false;
    if (expected > 0 && received >= expected) {
      sources[seq].ready = true;
      sourceComplete = true;
    }
    sources[seq].received = received;

    const allReady = sources.every((s) => (s.kind === "url" ? true : s.ready === true));
    const newStatus = allReady ? "queued" : String(jobRow.status);

    await db.execute({
      sql: "UPDATE merger_jobs SET sources_json = ?, status = ?, progress = 5 WHERE id = ?",
      args: [JSON.stringify(sources), newStatus, job],
    });

    sendJson(res, 200, {
      ok: true,
      seq,
      chunk,
      received,
      expected,
      sourceComplete,
      jobStatus: newStatus,
    });
  } catch (e) {
    sendError(res, 500, `تعذر حفظ الجزء: ${e.message}`);
  }
};
