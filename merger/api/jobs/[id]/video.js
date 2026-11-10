// GET /api/jobs/<id>/video — بث الفيديو الناتج مع دعم Range، و ?download=1 للتنزيل
const { sendJson, sendError } = require("../../../lib/http");
const { withDb } = require("../../../lib/turso");
const { readOutput } = require("../../../lib/store");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "GET") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم GET للبث");
    return;
  }
  const id = String(req.query.id || "");
  if (!id) return sendError(res, 400, "معرف المهمة مطلوب");

  try {
    const row = await withDb(async (db) => {
      const rows = await db.execute({ sql: "SELECT status FROM merger_jobs WHERE id = ?", args: [id] });
      return rows.rows[0] || null;
    });
    if (!row) return sendError(res, 404, "المهمة غير موجودة");
    if (row.status !== "done") {
      return sendError(res, 409, `الفيديو غير جاهز بعد — حالة المهمة: ${row.status}`);
    }

    // دعم Range: bytes=start-end
    const rangeHeader = req.headers.range || "";
    let start = null;
    let end = null;
    let isRange = false;
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (m && (m[1] !== "" || m[2] !== "")) {
      isRange = true;
      const data = await readOutput(id, 0, 0); // لمعرفة الحجم الكامل
      if (!data) return sendError(res, 404, "الناتج غير موجود");
      const total = data.total;
      if (m[1] === "") {
        // لاحقة: bytes=-N → آخر N بايت
        const n = Math.max(1, Number(m[2]));
        start = Math.max(0, total - n);
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
        if (start >= total) {
          setCorsHeaders(res);
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${total}`);
          res.end();
          return;
        }
      }
    }

    const data = await readOutput(id, start, end);
    if (!data) return sendError(res, 404, "الناتج غير موجود (حُذف أو انتهت صلاحيته)");

    setCorsHeaders(res);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (req.query.download === "1" || req.query.download === "true") {
      res.setHeader("Content-Disposition", `attachment; filename="merged-${id}.mp4"`);
    }
    res.setHeader("Content-Length", String(data.buffer.length));

    if (isRange) {
      res.statusCode = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${data.total}`);
    } else {
      res.statusCode = 200;
    }
    res.end(data.buffer);
  } catch (e) {
    sendError(res, 500, `تعذر بث الفيديو: ${e.message}`);
  }
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");
}
