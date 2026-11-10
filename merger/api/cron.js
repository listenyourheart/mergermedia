// GET /api/cron — حذف المهام المنتهية الصلاحية (Cron يومي عبر vercel.json)
// حذف شامل: المهمة + أجزاء المصادر + الفيديو الناتج
const { sendJson, sendError } = require("../lib/http");
const { withDb } = require("../lib/turso");

module.exports = async (req, res) => {
  if (req.method !== "GET") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم GET");
    return;
  }
  try {
    const deleted = await withDb(async (db) => {
      // المهام المنتهية صلاحيتها
      const rows = await db.execute({
        sql: "SELECT id FROM merger_jobs WHERE expires_at < datetime('now') OR expires_at < datetime('now', 'localtime') LIMIT 500",
        args: [],
      });
      const ids = rows.rows.map((r) => r.id);
      for (const id of ids) {
        await db.execute({ sql: "DELETE FROM merger_jobs WHERE id = ?", args: [id] });
        await db.execute({ sql: "DELETE FROM merger_chunks WHERE job_id = ?", args: [id] });
        await db.execute({ sql: "DELETE FROM merger_output WHERE job_id = ?", args: [id] });
      }
      return ids.length;
    });
    sendJson(res, 200, { ok: true, deletedJobs: deleted });
  } catch (e) {
    sendError(res, 500, `تعذر التنظيف: ${e.message}`);
  }
};
