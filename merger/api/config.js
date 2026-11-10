// GET /api/config — الحدود العامة + الإصدار (تُستخدم لفحص التوفر والمعاينة في الواجهة)
const { LIMITS, sendJson } = require("../lib/http");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  sendJson(res, 200, {
    version: LIMITS.version,
    service: "video-merger",
    limits: {
      maxClips: LIMITS.maxClips,
      minClips: LIMITS.minClips,
      maxSourceBytes: LIMITS.maxSourceBytes,
      maxOutputBytes: LIMITS.maxOutputBytes,
      maxTotalDurationSec: LIMITS.maxTotalDurationSec,
      uploadChunkBytes: LIMITS.uploadChunkBytes,
      retentionHours: LIMITS.retentionHours,
      fps: LIMITS.fps,
      crf: LIMITS.crf,
      maxResolution: LIMITS.maxResolution,
    },
    ffmpeg: "ready",
  });
};
