// خادم تطوير محلي يحاكي بيئة Vercel:
// - يحمّل ملف .env يدويًا (بلا تبعيات)
// - يحلل المسارات الديناميكية ويضع المعاملات في req.query (مثل [id] → req.query.id)
// - يخدم الواجهة الثابتة من public/ ونقاط النهاية من api/
require("fs")
  .readFileSync(require("path").join(__dirname, ".env"), "utf8")
  .split("\n")
  .forEach((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });

const http = require("http");
process.env.DEBUG_STACK = "1";
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3001;

// خريطة المسارات الديناميكية (بترتيب الأكثر تحديدًا أولاً)
const routes = [
  { pattern: /^\/api\/jobs\/([^/]+)\/process$/, file: "api/jobs/[id]/process.js", param: "id" },
  { pattern: /^\/api\/jobs\/([^/]+)\/video$/, file: "api/jobs/[id]/video.js", param: "id" },
  { pattern: /^\/api\/jobs\/([^/]+)$/, file: "api/jobs/[id].js", param: "id" },
  { pattern: /^\/api\/jobs$/, file: "api/jobs.js" },
  { pattern: /^\/api\/upload$/, file: "api/upload.js" },
  { pattern: /^\/api\/config$/, file: "api/config.js" },
  { pattern: /^\/api\/cron$/, file: "api/cron.js" },
];

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  req.query = Object.fromEntries(parsed.searchParams);

  try {
    // نقاط النهاية API
    for (const route of routes) {
      const m = route.pattern.exec(pathname);
      if (m) {
        if (route.param) req.query[route.param] = decodeURIComponent(m[1]);
        const handler = require(path.join(__dirname, route.file));
        await handler(req, res);
        return;
      }
    }

    // الواجهة الثابتة
    let filePath = pathname === "/" ? "/index.html" : pathname;
    const full = path.join(__dirname, "public", path.normalize(filePath).replace(/^([/\\])+/, ""));
    if (full.startsWith(path.join(__dirname, "public")) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      const ext = path.extname(full);
      const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
      res.statusCode = 200;
      res.setHeader("Content-Type", types[ext] || "application/octet-stream");
      fs.createReadStream(full).pipe(res);
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "المسار غير موجود" }));
  } catch (e) {
    console.error("server error:", e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify({ error: "خطأ داخلي في الخادم: " + e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`✅ خدمة دمج الفيديو تعمل محليًا على http://localhost:${PORT}`);
});
