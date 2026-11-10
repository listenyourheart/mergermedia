// POST /api/jobs — إنشاء مهمة دمج
// يقبل {"videos":[...]} أو {"sources":[{"kind":"url","url":...},{"kind":"file","name","size","mime"}]}
// يعيد 201 مع jobId + statusUrl + processUrl + expiresAt (و uploads[] مع uploadChunkBytes عند وجود ملفات)
const { LIMITS, sendJson, sendError, readJsonBody } = require("../lib/http");
const { withDb } = require("../lib/turso");

const PRIVATE_URL_RE =
  /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[::1\])/i;

function isValidPublicHttpUrl(u) {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (PRIVATE_URL_RE.test(u)) return false;
    if (/\.local$/i.test(parsed.hostname) || /\.internal$/i.test(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

function jobId() {
  // معرف قصير من 11 حرفًا (كما في أمثلة الخدمة)
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 11; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  if (req.method !== "POST") {
    sendError(res, 405, "الطريقة غير مسموحة — استخدم POST لإنشاء مهمة دمج");
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    if (e && e.badJson) return sendError(res, 400, "جسم الطلب ليس JSON صالحًا");
    if (e && e.tooLarge) return sendError(res, 413, "حجم الطلب كبير جدًا");
    return sendError(res, 400, "تعذر قراءة جسم الطلب");
  }

  // التطبيع: videos[] أو sources[]
  let sources = [];
  if (Array.isArray(body.videos)) {
    sources = body.videos.map((u) => ({ kind: "url", url: String(u || "").trim() }));
  } else if (Array.isArray(body.sources)) {
    sources = body.sources.map((s) =>
      s && s.kind === "file"
        ? { kind: "file", name: String(s.name || "source"), size: Number(s.size || 0), mime: String(s.mime || "video/mp4"), url: null }
        : { kind: "url", url: String((s && s.url) || "").trim() }
    );
  } else {
    return sendError(res, 400, "حقل videos أو sources مطلوب — مرّر روابط مباشرة أو مصادر ملفات");
  }

  if (sources.length < LIMITS.minClips) {
    return sendError(res, 400, `الدمج يتطلب ${LIMITS.minClips} مقاطع على الأقل`);
  }
  if (sources.length > LIMITS.maxClips) {
    return sendError(res, 400, `الحد الأقصى للمقاطع هو ${LIMITS.maxClips} (خدمة الدمج تقبل ${LIMITS.maxClips} مقاطع كحد أقصى)`);
  }

  // تحقق الروابط وأحجام الملفات
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (s.kind === "url") {
      if (!isValidPublicHttpUrl(s.url)) {
        return sendError(res, 400, `الرابط رقم ${i + 1} ليس رابط http/https مباشرًا عامًا`);
      }
    } else {
      if (!s.size || s.size <= 0) {
        return sendError(res, 400, `الملف رقم ${i + 1} بلا حجم صالح`);
      }
      if (s.size > LIMITS.maxSourceBytes) {
        return sendError(res, 413, `حجم الملف رقم ${i + 1} يتجاوز ${Math.round(LIMITS.maxSourceBytes / 1048576)} ميغابايت`);
      }
    }
  }

  const id = jobId();
  const hasFiles = sources.some((s) => s.kind === "file");
  const status = hasFiles ? "uploading" : "queued";
  const expiresAt = new Date(Date.now() + LIMITS.retentionHours * 3600 * 1000).toISOString();

  try {
    await withDb((db) =>
      db.execute({
        sql: "INSERT INTO merger_jobs (id, status, progress, sources_json, expires_at) VALUES (?, ?, 0, ?, ?)",
        args: [id, status, JSON.stringify(sources), expiresAt],
      })
    );

    const base = `https://${req.headers.host || "localhost:3001"}`;
    const response = {
      jobId: id,
      status,
      statusUrl: `${base}/api/jobs/${id}`,
      processUrl: `${base}/api/jobs/${id}/process`,
      expiresAt,
    };
    if (hasFiles) {
      response.uploadChunkBytes = LIMITS.uploadChunkBytes;
      response.uploads = sources.map((s, i) => ({
        seq: i,
        source: s.kind === "file" ? { name: s.name, size: s.size, mime: s.mime } : { url: s.url },
        uploadUrl: `${base}/api/upload?job=${id}&seq=${i}&chunk={chunk}`,
      }));
    }
    sendJson(res, 201, response);
  } catch (e) {
    sendError(res, 500, `تعذر إنشاء المهمة: ${e.message}`);
  }
};
