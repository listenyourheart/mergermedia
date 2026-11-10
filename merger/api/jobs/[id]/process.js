// POST /api/jobs/<id>/process — تنفيذ الدمج الكامل (متزامن):
// تنزيل/تجميع المصادر ← ffprobe ← توحيد + دمج ffmpeg ← حفظ الناتج في Turso
// يعيد مباشرة {"status":"done",...} أو 202 إذا كانت قيد المعالجة
const fs = require("fs");
const path = require("path");
const os = require("os");
const { LIMITS, sendJson, sendError } = require("../../../lib/http");
const { withDb } = require("../../../lib/turso");
const { saveOutput } = require("../../../lib/store");
const { probeFile, mergeVideos, downloadToTmp } = require("../../../lib/ffmpeg");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم POST لتنفيذ الدمج");
    return;
  }
  const id = String(req.query.id || "");
  if (!id) return sendError(res, 400, "معرف المهمة مطلوب");

  let row;
  try {
    row = await withDb(async (db) => {
      const rows = await db.execute({ sql: "SELECT * FROM merger_jobs WHERE id = ?", args: [id] });
      return rows.rows[0] || null;
    });
  } catch (e) {
    return sendError(res, 500, `تعذر الوصول للمهمة: ${e.message}`);
  }
  if (!row) return sendError(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

  // إذا اكتملت سابقًا → أعد النتيجة مباشرة
  if (row.status === "done" && row.result_json) {
    const base = `https://${req.headers.host || "localhost:3001"}`;
    const r = JSON.parse(row.result_json);
    return sendJson(res, 200, {
      status: "done",
      videoUrl: r.videoUrl || `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: r.size,
      duration: r.duration,
      resolution: r.resolution,
      expiresAt: row.expires_at,
    });
  }
  // إذا قيد المعالجة → 202 (طلب آخر ينفذ الدمج)
  if (row.status === "processing") {
    return sendJson(res, 202, { status: "processing", progress: Number(row.progress || 0) });
  }

  let sources;
  try {
    sources = JSON.parse(row.sources_json);
  } catch {
    return sendError(res, 400, "بيانات المصادر تالفة");
  }

  const urlSources = sources.filter((s) => s.kind === "url");
  const fileSources = sources.filter((s) => s.kind === "file");
  const allReady = fileSources.every((s) => s.ready === true);
  if (row.status === "uploading" && !allReady) {
    return sendError(res, 409, "الملفات المصدرية لم تُرفع بالكامل بعد — أكمل الرفع ثم أعد المحاولة");
  }

  // حجز حالة المعالجة قبل العمل الثقيل
  await withDb((db) =>
    db.execute({ sql: "UPDATE merger_jobs SET status = 'processing', progress = 5, error = NULL WHERE id = ?", args: [id] })
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-"));
  const inputPaths = [];
  try {
    let totalBytes = 0;
    let totalDuration = 0;

    // 1) تجهيز المصادر (تنزيل الروابط / تجميع الملفات المرفوعة)
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dest = path.join(tmpDir, `src_${i}.bin`);
      if (s.kind === "url") {
        await downloadToTmp(s.url, dest);
      } else {
        const received = await require("../../../lib/store").assembleSourceFile(id, i, dest, Number(s.size || 0));
        if (s.size && received < Number(s.size)) {
          throw new Error(`الملف رقم ${i + 1} غير مكتمل (${received}/${s.size} بايت)`);
        }
      }
      const st = fs.statSync(dest);
      totalBytes += st.size;
      if (st.size > LIMITS.maxSourceBytes) {
        throw new Error(`حجم المصدر رقم ${i + 1} يتجاوز ${Math.round(LIMITS.maxSourceBytes / 1048576)} ميغابايت`);
      }
      if (totalBytes > LIMITS.maxTotalBytes) {
        throw new Error(`إجمالي حجم المصادر يتجاوز السقف (${Math.round(LIMITS.maxTotalBytes / 1048576)} ميغابايت)`);
      }
      inputPaths.push(dest);
    }

    // 2) ffprobe لكل مصدر: الدقة/الإطارات/المدة/الصوت
    await withDb((db) => db.execute({ sql: "UPDATE merger_jobs SET progress = 20 WHERE id = ?", args: [id] }));
    const probes = [];
    for (const p of inputPaths) {
      const probe = await probeFile(p);
      totalDuration += probe.duration;
      probes.push(probe);
    }
    if (probes.some((p) => !p.width || !p.height)) {
      throw new Error("أحد المصادر ليس فيديو صالحًا");
    }
    if (totalDuration > LIMITS.maxTotalDurationSec) {
      throw new Error(`إجمالي مدة المقاطع ${Math.round(totalDuration)} ثانية يتجاوز الحد ${LIMITS.maxTotalDurationSec} ثانية`);
    }

    // 3) الدمج الموحد (scale+pad+fps+concat) بجودة CRF 18
    await withDb((db) => db.execute({ sql: "UPDATE merger_jobs SET progress = 40 WHERE id = ?", args: [id] }));
    const outputPath = path.join(tmpDir, "out.mp4");
    const target = await mergeVideos(inputPaths, probes, outputPath);

    // 4) التحقق من الناتج وحجمه
    const st = fs.statSync(outputPath);
    if (st.size > LIMITS.maxOutputBytes) {
      throw new Error(`حجم الناتج ${Math.round(st.size / 1048576)} ميغابايت يتجاوز الحد ${Math.round(LIMITS.maxOutputBytes / 1048576)} ميغابايت`);
    }

    // 5) حفظ الناتج في Turso كأجزاء
    await withDb((db) => db.execute({ sql: "UPDATE merger_jobs SET progress = 80 WHERE id = ?", args: [id] }));
    const outBuffer = fs.readFileSync(outputPath);
    await saveOutput(id, outBuffer);

    const outProbe = await probeFile(outputPath).catch(() => null);
    const base = `https://${req.headers.host || "localhost:3001"}`;
    const result = {
      videoUrl: `${base}/api/jobs/${id}/video`,
      downloadUrl: `${base}/api/jobs/${id}/video?download=1`,
      size: st.size,
      duration: outProbe ? outProbe.duration : Math.round(totalDuration * 100) / 100,
      resolution: outProbe ? `${outProbe.width}x${outProbe.height}` : `${target.width}x${target.height}`,
    };
    await withDb((db) =>
      db.execute({
        sql: "UPDATE merger_jobs SET status = 'done', progress = 100, result_json = ? WHERE id = ?",
        args: [JSON.stringify(result), id],
      })
    );

    sendJson(res, 200, { status: "done", ...result, expiresAt: row.expires_at });
  } catch (e) {
    // فشل نهائي — رسالة عربية واضحة (إعادة المحاولة تعطي نفس النتيجة لمشاكل المصادر)
    const msg = e.message || String(e);
    await withDb((db) =>
      db.execute({ sql: "UPDATE merger_jobs SET status = 'failed', progress = 0, error = ? WHERE id = ?", args: [msg.slice(0, 500), id] })
    );
    sendError(res, 500, msg + (process.env.DEBUG_STACK ? "\n" + e.stack : ""));
  } finally {
    // تنظيف الملفات المؤقتة
    try {
      for (const p of inputPaths) fs.unlinkSync(p);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // تجاهل أخطاء التنظيف
    }
  }
};
