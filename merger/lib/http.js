// مساعدات HTTP مشتركة: CORS مفتوح + أخطاء بصيغة {"error":"..."} بالعربية + قراءة الجسم الخام
const LIMITS = {
  version: "1.0.0",
  maxClips: 10,
  minClips: 2,
  maxSourceBytes: 200 * 1024 * 1024, // 200 ميغابايت لكل مصدر
  maxOutputBytes: 150 * 1024 * 1024, // 150 ميغابايت للناتج
  maxTotalBytes: 450 * 1024 * 1024, // سقف إجمالي للتنزيلات في /tmp
  maxTotalDurationSec: 600, // 10 دقائق إجمالاً
  uploadChunkBytes: 4 * 1024 * 1024, // 4 ميغابايت للجزء الواحد
  retentionHours: 24, // حذف تلقائي بعد 24 ساعة
  fps: 30,
  crf: 18,
  maxResolution: { width: 1920, height: 1080 },
};

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Disposition");
}

function sendJson(res, status, obj) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

/** قراءة الجسم الخام مع سقف حجم — يعيد Buffer أو يرمي كائن {tooLarge:true} */
function readRawBody(req, maxBytes = LIMITS.uploadChunkBytes + 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    req.on("data", (c) => {
      received += c.length;
      if (received > maxBytes) {
        reject({ tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (e) => reject(e));
  });
}

async function readJsonBody(req, maxBytes = 2 * 1024 * 1024) {
  const buf = await readRawBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw { badJson: true };
  }
}

module.exports = { LIMITS, setCors, sendJson, sendError, readRawBody, readJsonBody };
