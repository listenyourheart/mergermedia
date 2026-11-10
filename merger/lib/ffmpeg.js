// محرك الدمج بالـ ffmpeg — جودة عالية إلزامية:
// ffprobe لكل مصدر (الدقة/معدل الإطارات/المدة/وجود صوت) ثم توحيد كل المصادر:
// scale + pad إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080 بأبعاد زوجية)، fps=30، setsar=1، format=yuv420p ثم concat نظيف
const fs = require("fs");
const path = require("path");
const os = require("os");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const { LIMITS } = require("./http");

const { execFile: execFileCb } = require("child_process");
const util = require("util");
const execFile = util.promisify(execFileCb);

/** فحص مصدر بـ ffprobe: الدقة، معدل الإطارات، المدة، وجود صوت */
async function probeFile(filePath) {
  const { stdout } = await execFile(
    ffprobePath,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }
  );
  const meta = JSON.parse(stdout);
  const video = (meta.streams || []).find((s) => s.codec_type === "video");
  const audio = (meta.streams || []).find((s) => s.codec_type === "audio");
  if (!video) throw new Error("الملف لا يحتوي مسار فيديو صالح");
  const duration = Number(
    (meta.format && meta.format.duration) || video.duration || 0
  );
  const [num, den] = String(video.r_frame_rate || "30/1").split("/");
  const fps = den ? Number(num) / Number(den) : Number(num) || 30;
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: Math.round(fps * 100) / 100,
    duration: Math.round(duration * 1000) / 1000,
    hasAudio: !!audio,
  };
}

function evenDown(n) {
  return Math.max(2, 2 * Math.floor(n / 2));
}

/** حساب الدقة الهدف: أكبر دقة بين المدخلات بحد أقصى 1920×1080 وبأبعاد زوجية */
function targetResolution(probes) {
  let w = 0;
  let h = 0;
  for (const p of probes) {
    if (p.width * p.height > w * h) {
      w = p.width;
      h = p.height;
    }
  }
  if (!w || !h) {
    w = 1280;
    h = 720;
  }
  const scale = Math.min(1, LIMITS.maxResolution.width / w, LIMITS.maxResolution.height / h);
  return { width: evenDown(Math.round(w * scale)), height: evenDown(Math.round(h * scale)) };
}

/** بناء أمر ffmpeg للدمج الموحد عالي الجودة */
async function mergeVideos(inputPaths, probes, outputPath, onProgress) {
  const target = targetResolution(probes);
  const args = ["-y"];

  // المدخلات: الملفات + مدخلات صوت صامت لكل مصدر بلا صوت
  const filters = [];
  const concatPairs = [];
  let lavfiIndex = inputPaths.length;
  for (let i = 0; i < inputPaths.length; i++) {
    args.push("-i", inputPaths[i]);
  }

  for (let i = 0; i < inputPaths.length; i++) {
    const p = probes[i];
    // توحيد الفيديو: scale + pad إلى الهدف ثم fps و SAR وصيغة البكسل
    filters.push(
      `[${i}:v]scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease,` +
        `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `fps=${LIMITS.fps},setsar=1,format=yuv420p[v${i}]`
    );
    // توحيد الصوت: معدل عينات ومساحة قنوات موحدة — أو صمت كامل للمصادر بلا صوت
    if (p.hasAudio) {
      filters.push(
        `[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
      );
    } else {
      args.push("-f", "lavfi", "-t", String(Math.max(1, p.duration)), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      filters.push(`[${lavfiIndex}:a]aresample=44100[a${i}]`);
      lavfiIndex++;
    }
    concatPairs.push(`[v${i}][a${i}]`);
  }

  const n = inputPaths.length;
  filters.push(`${concatPairs.join("")}concat=n=${n}:v=1:a=1[vout][aout]`);

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[vout]",
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    String(LIMITS.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    outputPath
  );

  if (onProgress) onProgress("جارٍ الترميز الموحد للفيديو...", 40);
  await execFile(ffmpegPath, args, {
    timeout: 280_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return target;
}

/** تنزيل مصدر رابط إلى /tmp مع سقف حجم */
async function downloadToTmp(url, destPath, maxBytes = LIMITS.maxSourceBytes) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`فشل تنزيل المصدر (HTTP ${res.status}): ${url.slice(0, 80)}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > maxBytes) throw new Error(`حجم المصدر يتجاوز ${Math.round(maxBytes / 1048576)} ميغابايت: ${url.slice(0, 80)}`);
  const ws = fs.createWriteStream(destPath);
  let received = 0;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      ws.end();
      throw new Error(`حجم المصدر يتجاوز الحد أثناء التنزيل: ${url.slice(0, 80)}`);
    }
    ws.write(Buffer.from(value));
  }
  await new Promise((resolve) => ws.end(resolve));
  return received;
}

module.exports = { probeFile, targetResolution, mergeVideos, downloadToTmp };
