// GET /api/jobs/<id> — الحالة + التقدم (0..100) + الروابط عند الاكتمال
// DELETE /api/jobs/<id> — حذف فوري كامل (المهمة + الأجزاء + الناتج)
const { LIMITS, sendJson, sendError } = require("../../lib/http");
const { withDb } = require("../../lib/turso");

function baseUrlOf(req) {
  return `https://${req.headers.host || "localhost:3001"}`;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const id = String(req.query.id || "");
  if (!id) return sendError(res, 400, "معرف المهمة مطلوب");

  if (req.method === "DELETE") {
    try {
      await withDb(async (db) => {
        await db.execute({ sql: "DELETE FROM merger_jobs WHERE id = ?", args: [id] });
        await db.execute({ sql: "DELETE FROM merger_chunks WHERE job_id = ?", args: [id] });
        await db.execute({ sql: "DELETE FROM merger_output WHERE job_id = ?", args: [id] });
      });
      sendJson(res, 200, { ok: true, deleted: id });
    } catch (e) {
      sendError(res, 500, `تعذر الحذف: ${e.message}`);
    }
    return;
  }

  if (req.method !== "GET") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم GET للحالة أو DELETE للحذف");
    return;
  }

  try {
    const row = await withDb(async (db) => {
      const rows = await db.execute({ sql: "SELECT * FROM merger_jobs WHERE id = ?", args: [id] });
      return rows.rows[0] || null;
    });
    if (!row) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    const base = baseUrlOf(req);
    const response = {
      jobId: id,
      status: String(row.status),
      progress: Number(row.progress || 0),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      statusUrl: `${base}/api/jobs/${id}`,
      processUrl: `${base}/api/jobs/${id}/process`,
    };

    if (row.status === "done") {
      const result = row.result_json ? JSON.parse(row.result_json) : {};
      response.videoUrl = result.videoUrl || `${base}/api/jobs/${id}/video`;
      response.downloadUrl = `${base}/api/jobs/${id}/video?download=1`;
      response.size = result.size;
      response.duration = result.duration;
      response.resolution = result.resolution;
    }
    if (row.error) response.error = row.error;

    sendJson(res, 200, response);
  } catch (e) {
    sendError(res, 500, `تعذر جلب الحالة: ${e.message}`);
  }
};
