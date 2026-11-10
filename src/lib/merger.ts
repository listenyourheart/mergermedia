// عميل خدمة دمج الفيديو (Video Merger API v2) — روابط فقط، بلا مفاتيح أو مصادقة
// قواعد حاسمة:
// - خطأ HTTP مصرَّح به من الخدمة (4xx/5xx مع جسم خطأ) = فشل نهائي فوري بلا إعادة محاولة
// - أخطاء شبكتنا (مهلة/انقطاع) = مؤقتة → الاستمرار في الاستعلام حتى نهاية النافذة
// - progress قد يصل كسر 0..1 → يُضرب في 100
// - تحليل حالة دفاعي: done|completed|complete|success|succeeded|finished = مكتمل، error|failed|failure|cancelled = فاشل
// - جسم يحتوي خطأ بلا حقل status → يُعامل فورًا كفشل
import { randomUUID } from "crypto";
import {
  insertTask,
  getTask,
  updateTask,
  listRecentTasks,
  type TaskRow,
} from "./turso";
import { parseUrls } from "./orchestrator";

const BASE = (process.env.MERGER_API_BASE || "https://xxxxxxxx").replace(/\/+$/, "");
const POLL_INTERVAL_MS = 3_000;

/** قفل في الذاكرة لضمان تشغيل خطوة process مرة واحدة فقط لكل مهمة دمج */
const processInFlight: Set<string> =
  ((globalThis as Record<string, unknown>).__mergerProcessInFlight as Set<string>) ??
  new Set<string>();
(globalThis as Record<string, unknown>).__mergerProcessInFlight = processInFlight;

// ————— أخطاء —————

/** خطأ مصرَّح به من الخدمة → فشل نهائي (بلا إعادة محاولة) */
export class MergerHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "MergerHttpError";
    this.status = status;
  }
}

/** مهلة/انقطاع شبكتنا → مؤقت */
export class MergerNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergerNetworkError";
  }
}

/** رفض منطقي قبل الاتصال (أقل من مقطعين/أكثر من 10/رابط غير صالح) */
export class MergeReject extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeReject";
  }
}

// ————— أدوات تحليل دفاعية —————

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED_RE = /^(error|failed|failure|cancelled|canceled)$/i;

function normalizeProgress(p: unknown): number {
  const n = typeof p === "number" ? p : Number(p);
  if (!isFinite(n)) return 0;
  // أحيانًا تصل نسبة كسر 0..1 → اضربها في 100
  return Math.max(0, Math.min(100, Math.round(n <= 1 && n > 0 ? n * 100 : n)));
}

function extractResultUrl(body: Record<string, unknown>, jobId: string): string {
  // الأولوية: videoUrl ثم downloadUrl ثم بناء رابط الفيديو من معرف المهمة
  if (typeof body.videoUrl === "string" && body.videoUrl) return body.videoUrl;
  if (typeof body.downloadUrl === "string" && body.downloadUrl) return body.downloadUrl;
  return `${BASE}/api/jobs/${jobId}/video`;
}

async function mergerFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = 120_000
): Promise<{ status: number; body: Record<string, unknown>; bodyText: string }> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new MergerNetworkError(e instanceof Error ? e.message : String(e));
  }
  const bodyText = await res.text().catch(() => "");
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!res.ok) {
    const msg =
      (typeof body.error === "string" && body.error) ||
      bodyText.slice(0, 300) ||
      `HTTP ${res.status}`;
    throw new MergerHttpError(res.status, msg);
  }
  return { status: res.status, body, bodyText };
}

// ————— تحقق الروابط —————

const PRIVATE_URL_RE =
  /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[::1\])/i;

function isValidPublicHttpUrl(u: string): boolean {
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

// ————— التشغيل —————

export interface RunMergeResult {
  task: TaskRow | null;
  rejected?: string; // رسالة رفض عربية عند خطأ المدخلات
}

/** تشغيل الدمج: حل task_ids → تحقق صارم → تسجيل المهمة → إنشاء مهمة الخدمة → process مرة واحدة → تتبع بالتقدم */
export async function runMerge(opts: {
  urls?: string[];
  taskIds?: string[];
  waitSeconds: number;
  onProgress?: (progress: number, message: string) => void;
}): Promise<RunMergeResult> {
  const directUrls = (opts.urls ?? []).map((u) => String(u).trim()).filter(Boolean);
  const taskIds = (opts.taskIds ?? []).map((u) => String(u).trim()).filter(Boolean);

  // 1) حل الروابط من task_ids بالترتيب — المهام المكتملة فقط
  const resolvedUrls: string[] = [];
  const failedTaskDetails: string[] = [];
  for (const tid of taskIds) {
    const t = await getTask(tid);
    const urls = t ? parseUrls(t.result_urls_json) : [];
    if (!t || t.status !== "completed" || !urls.length) {
      failedTaskDetails.push(
        `- ${tid}: ${!t ? "غير موجودة" : t.status !== "completed" ? `الحالة ${t.status} (ليست مكتملة)` : "بلا روابط نتيجة"}`
      );
    } else {
      resolvedUrls.push(...urls);
    }
  }

  // 2) الترتيب النهائي: روابط task_ids أولاً ثم روابط urls المباشرة بترتيبها
  const videos = [...resolvedUrls, ...directUrls];

  // 3) تحقق صارم
  if (taskIds.length && failedTaskDetails.length === taskIds.length && videos.length < 2) {
    throw new MergeReject(
      "❌ الدمج يتطلب مقطعين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.\n\nتفاصيل المعرفات:\n" +
        failedTaskDetails.join("\n")
    );
  }
  if (videos.length < 2) {
    let msg = "❌ الدمج يتطلب مقطعين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failedTaskDetails.length) msg += "\n\nتفاصيل المعرفات:\n" + failedTaskDetails.join("\n");
    throw new MergeReject(msg);
  }
  if (videos.length > 10) {
    throw new MergeReject("❌ الحد الأقصى لمقاطع الدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).");
  }
  const invalid = videos.filter((u) => !isValidPublicHttpUrl(u));
  if (invalid.length) {
    throw new MergeReject(
      "❌ يجب أن تكون كل المقاطع روابط http/https مباشرة عامة. روابط غير صالحة:\n" +
        invalid.join("\n")
    );
  }

  // 4) تسجيل المهمة في Turso أولاً (type=merge, provider=merger, model=video-merger)
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: "",
    params_json: JSON.stringify({ videos }),
    status: "pending",
    progress: 0,
  });

  // 5) إنشاء مهمة في خدمة الدمج
  try {
    const { body } = await mergerFetch(
      "/api/jobs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos }),
      },
      30_000
    );
    const jobId = typeof body.jobId === "string" ? body.jobId : null;
    if (!jobId) throw new MergerHttpError(500, "الخدمة لم تعرف jobId في الرد");
    await updateTask(taskId, {
      provider_task_id: jobId,
      status: "processing",
      progress: 5,
    });

    // 6) إطلاق process بالخلفية مرة واحدة (محمي بقفل في الذاكرة) — لا ننتظره هنا
    void startProcess(jobId);

    // 7) تتبع حتى نهاية النافذة مع بث التقدم
    const deadline = Date.now() + Math.max(0, opts.waitSeconds) * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      if (Date.now() >= deadline) break;

      const state = await pollMergeJob(taskId, jobId);
      if (state === "completed" || state === "failed") {
        return { task: await getTask(taskId) };
      }
      const current = await getTask(taskId);
      opts.onProgress?.(
        current?.progress ?? 10,
        `⏳ جارٍ الدمج... ${current?.progress ?? 10}%`
      );
    }

    // انتهت النافذة → المهمة تبقى processing والعميل يتابع عبر get_task
    return { task: await getTask(taskId) };
  } catch (e) {
    if (e instanceof MergerNetworkError) {
      // خطأ شبكتنا عند الإنشاء → نترك المهمة processing وتُعاد المحاولة عبر get_task
      await updateTask(taskId, {
        status: "processing",
        error_message: "تعذر الاتصال بخدمة الدمج مؤقتًا — ستُعاد المحاولة تلقائيًا",
      });
      return { task: await getTask(taskId) };
    }
    const msg = e instanceof Error ? e.message : String(e);
    await updateTask(taskId, {
      status: "failed",
      error_message: `فشل إنشاء مهمة الدمج: ${msg.slice(0, 300)}`,
    });
    return { task: await getTask(taskId) };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** استعلام حالة مهمة الدمج وتحديث Turso — يعيد الحالة الفعّالة */
async function pollMergeJob(taskId: string, jobId: string): Promise<"completed" | "failed" | "processing"> {
  try {
    const { body } = await mergerFetch(`/api/jobs/${jobId}`, undefined, 15_000);
    const rawStatus = typeof body.status === "string" ? body.status : "";
    const errorBody = typeof body.error === "string" ? body.error : "";

    // جسم يحتوي خطأ بلا حقل status → فشل فوري
    if (errorBody && !rawStatus) {
      await updateTask(taskId, {
        status: "failed",
        error_message: `فشل الدمج: ${errorBody.slice(0, 300)}`,
        progress: 0,
      });
      return "failed";
    }

    if (rawStatus && DONE_RE.test(rawStatus)) {
      const url = extractResultUrl(body, jobId);
      await updateTask(taskId, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify([url]),
        error_message: null,
      });
      return "completed";
    }

    if ((rawStatus && FAILED_RE.test(rawStatus)) || errorBody) {
      const msg = errorBody || rawStatus;
      await updateTask(taskId, {
        status: "failed",
        error_message: `فشل الدمج: ${String(msg).slice(0, 300)}`,
        progress: 0,
      });
      return "failed";
    }

    // قيد المعالجة — كتابة التقدم فورًا في كل استعلام
    const progress = normalizeProgress(body.progress);
    await updateTask(taskId, { status: "processing", progress: Math.max(5, progress) });
    return "processing";
  } catch (e) {
    if (e instanceof MergerNetworkError) {
      // خطأ شبكتنا = مؤقت → الاستمرار في الاستعلام حتى نهاية النافذة (لا نغيّر الحالة)
      return "processing";
    }
    // خطأ مصرَّح به من الخدمة (4xx/5xx) = فشل نهائي فوري
    const msg = e instanceof Error ? e.message : String(e);
    await updateTask(taskId, {
      status: "failed",
      error_message: `فشل الدمج: ${msg.slice(0, 300)}`,
      progress: 0,
    });
    return "failed";
  }
}

/** تنفيذ خطوة process مرة واحدة لكل مهمة — محمية بقفل في الذاكرة */
async function startProcess(jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  try {
    await mergerFetch(`/api/jobs/${jobId}/process`, { method: "POST" }, 120_000);
  } catch {
    // الخطأ يُرصد من الاستعلام — هنا نتجاهل (process غير المتزامن)
  } finally {
    processInFlight.delete(jobId);
  }
}

/** تحديث مهمة دمج قائمة من خدمة الدمج — تُستدعى من get_task */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow | null> {
  // لم تُنشأ مهمة الخدمة بعد (فشل شبكة سابق) — راحة ثم إعادة إنشاء من المعاملات المحفوظة
  if (!task.provider_task_id) {
    const updatedMs = task.updated_at ? Date.parse(task.updated_at.replace(" ", "T") + "Z") : 0;
    const elapsed = Date.now() - (isNaN(updatedMs) ? 0 : updatedMs);
    if (elapsed < 45_000) return task;
    let params: { videos?: string[] } = {};
    try {
      params = JSON.parse(task.params_json || "{}") as { videos?: string[] };
    } catch {
      params = {};
    }
    const videos = params.videos ?? [];
    if (videos.length >= 2) {
      try {
        const { body } = await mergerFetch(
          "/api/jobs",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videos }),
          },
          30_000
        );
        const jobId = typeof body.jobId === "string" ? body.jobId : null;
        if (jobId) {
          await updateTask(task.id, { provider_task_id: jobId, status: "processing", progress: 5 });
          void startProcess(jobId);
        }
      } catch (e) {
        if (e instanceof MergerHttpError) {
          await updateTask(task.id, {
            status: "failed",
            error_message: `فشل إنشاء مهمة الدمج: ${e.message.slice(0, 300)}`,
          });
        }
        // خطأ شبكة → تبقى processing للمحاولة القادمة
      }
    }
    return getTask(task.id);
  }

  const jobId = task.provider_task_id;

  try {
    const { status, body } = await mergerFetch(`/api/jobs/${jobId}`, undefined, 15_000);
    if (status === 404) {
      // المهمة غير موجودة لدى الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)
      await updateTask(task.id, {
        status: "failed",
        error_message: "المهمة غير موجودة في خدمة الدمج (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        progress: 0,
      });
      return getTask(task.id);
    }
    const rawStatus = typeof body.status === "string" ? body.status : "";
    const errorBody = typeof body.error === "string" ? body.error : "";

    if (errorBody && !rawStatus) {
      await updateTask(task.id, {
        status: "failed",
        error_message: `فشل الدمج: ${errorBody.slice(0, 300)}`,
        progress: 0,
      });
      return getTask(task.id);
    }

    if (rawStatus && DONE_RE.test(rawStatus)) {
      const url = extractResultUrl(body, jobId);
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        result_urls_json: JSON.stringify([url]),
        error_message: null,
      });
      return getTask(task.id);
    }

    if ((rawStatus && FAILED_RE.test(rawStatus)) || errorBody) {
      await updateTask(task.id, {
        status: "failed",
        error_message: `فشل الدمج: ${String(errorBody || rawStatus).slice(0, 300)}`,
        progress: 0,
      });
      return getTask(task.id);
    }

    // قيد المعالجة: إن لم تُنفَّذ process بعد، نفّذها الآن
    const progress = normalizeProgress(body.progress);
    if (progress < 1 && !processInFlight.has(jobId)) {
      void startProcess(jobId);
    }
    await updateTask(task.id, { status: "processing", progress: Math.max(5, progress) });
    return getTask(task.id);
  } catch (e) {
    if (e instanceof MergerHttpError && e.status === 404) {
      await updateTask(task.id, {
        status: "failed",
        error_message: "المهمة غير موجودة في خدمة الدمج (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        progress: 0,
      });
      return getTask(task.id);
    }
    // خطأ شبكتنا → تبقى processing (تُستأنف عند الاستعلام القادم)
    return getTask(task.id);
  }
}

/** فحص توفر خدمة الدمج (GET /api/config بمهلة 4 ثوانٍ) */
export async function mergerHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/config`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function mergerBase(): string {
  return BASE;
}

/** إحصاء آخر المهام للعرض */
export async function recentTasksForList(
  limit: number,
  filters: { type?: string; status?: string }
): Promise<TaskRow[]> {
  return listRecentTasks(limit, filters);
}
