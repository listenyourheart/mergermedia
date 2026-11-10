// مُنسّق التوليد — قلب المشروع: تجربة المفاتيح بالترتيب الصارم مع تبديل "صفر توقف"
// القواعد الذهبية المنفَّذة هنا:
// 1) المفاتيح تُجرَّب بالترتيب حسب أوقات الإضافة (created_at ASC, id ASC) — ليست round-robin
// 2) عند فشل مفتاح (استنفاد/رفض/مؤقت) ننتقل للمفتاح التالي فورًا ونستأنف المهمة نفسها بنفس task_id
// 3) نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا — التبديل صامت من وجهة نظره
// 4) مهمة فشلت على كل المفاتيح تبقى processing وتُعاد المحاولة تلقائيًا عند كل get_task (بعد فترة راحة ~45 ثانية)
import { randomUUID } from "crypto";
import {
  insertTask,
  getTask,
  updateTask,
  getKey,
  getKeyPool,
  recordKeyUsage,
  type TaskRow,
  type AttemptEntry,
  type KeyRow,
} from "./turso";
import { classifyProviderError, isKeyRelatedFailure } from "./classify";
import { normalizeModelName, type ModelDef } from "./models";
import { ADAPTERS } from "./providers";
import { ProviderError, NetworkError } from "./providers/types";

const POLL_INTERVAL_MS = 3_000; // استعلام الحالة كل 3 ثوانٍ أثناء نافذة الانتظار
const RETRY_REST_MS = 45_000; // فترة راحة قبل إعادة محاولة كل المفاتيح عند get_task

/** على Vercel نقصّر نافذة الانتظار لتجنب قطع الدالة قبل عودة task_id (العميل يكمل التتبع عبر get_task) */
function effectiveWaitSeconds(requested: number): number {
  const cap = process.env.VERCEL === "1" ? 50 : 240;
  return Math.max(0, Math.min(Math.floor(requested), cap));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ————— أنواع النتائج الداخلية —————

interface PoolOutcome {
  completed: boolean;
  windowEnded?: boolean;
  allKeysFailed?: boolean;
  finalFailure?: string; // رسالة فشل حقيقية (ليست متعلقة بالمفاتيح)
}

interface GenContext {
  taskId: string;
  type: "image" | "video";
  model: ModelDef;
  prompt: string;
  params: Record<string, unknown>;
  windowStartMs: number;
  deadlineMs: number;
  onProgress?: (progress: number, message: string) => void;
}

// قفل بسيط لمنع تحديثات متوازية لنفس المهمة عبر get_task المتكررة (لكل عملية)
const refreshLocks: Map<string, Promise<TaskRow | null>> =
  ((globalThis as Record<string, unknown>).__genRefreshLocks as Map<
    string,
    Promise<TaskRow | null>
  >) ?? new Map();
(globalThis as Record<string, unknown>).__genRefreshLocks = refreshLocks;

// ————— بناء مدخلات المزود —————

function buildProviderInput(ctx: GenContext): Record<string, unknown> {
  if (ctx.type === "image") {
    const input: Record<string, unknown> = { prompt: ctx.prompt };
    const p = ctx.params;
    if (p.aspect_ratio) input.aspect_ratio = p.aspect_ratio;
    if (p.resolution) input.resolution = p.resolution;
    // الخلفية تُطبق فقط على 1K وفق التوثيق
    if (p.background) input.background = p.background;
    if (p.output_format) input.output_format = p.output_format;
    return input;
  }
  // فيديو: kie يولّد الصوت دائمًا مع الفيديو (لا يوجد enable_audio في التوثيق — لا نرسله)
  const input: Record<string, unknown> = { prompt: ctx.prompt };
  const p = ctx.params;
  if (typeof p.image_url === "string" && p.image_url) input.image_urls = [p.image_url];
  if (p.aspect_ratio) input.aspect_ratio = p.aspect_ratio;
  if (p.resolution) input.resolution = p.resolution;
  if (typeof p.duration === "number") input.duration = p.duration;
  return input;
}

// ————— أدوات مساعدة —————

function entry(key: KeyRow, ok: boolean, errorClass?: string, error?: string): AttemptEntry {
  return {
    provider: key.provider,
    keyId: key.id,
    keyLabel: key.label || key.id.slice(0, 8),
    ok,
    errorClass,
    error,
    at: new Date().toISOString(),
  };
}

async function completeTask(taskId: string, urls: string[]): Promise<void> {
  if (!urls.length) throw new Error("اكتمال بلا روابط");
  await updateTask(taskId, {
    status: "completed",
    progress: 100,
    result_urls_json: JSON.stringify(urls),
    error_message: null,
  });
}

/** تنظيف رسالة الفشل الظاهرة للعميل — تضمين أسباب حقيقية فقط، لا شيء متعلق بالمفاتيح */
function clientFailureMessage(raw: string): string {
  const msg = (raw || "سبب غير معروف").slice(0, 400);
  return msg;
}

async function failTask(taskId: string, raw: string): Promise<string> {
  const msg = clientFailureMessage(raw);
  await updateTask(taskId, { status: "failed", error_message: msg });
  return msg;
}

/** تقدّر النسبة إن لم يوفرها المزود (صورة ~60 ثانية، فيديو ~120 ثانية) */
function heuristicProgress(elapsedMs: number, type: "image" | "video"): number {
  const expected = type === "image" ? 60_000 : 120_000;
  return Math.max(3, Math.min(90, Math.round((elapsedMs / expected) * 90)));
}

// ————— الحلقة التسلسلية على المفاتيح —————

/**
 * تجربة المفاتيح بالترتيب من startIndex — أول نجاح يربط المهمة بالمزود والمفتاح.
 * عند فشل مفتاح في منتصف المهمة بسبب مفتاح/رصيد: تُعاد المهمة نفسها (نفس task_id) على المفتاح التالي.
 */
async function attemptPool(ctx: GenContext, pool: KeyRow[], startIndex: number): Promise<PoolOutcome> {
  const input = buildProviderInput(ctx);
  const providerModelFor = (provider: string) => ctx.model.providerModel[provider as "kie"] ?? ctx.model.canonical;

  for (let i = Math.max(0, startIndex); i < pool.length; i++) {
    const key = pool[i];
    const adapter = ADAPTERS[key.provider];
    if (!adapter) continue;

    try {
      // صور متزامنة (CometAPI) — نتيجة فورية
      if (ctx.type === "image" && adapter.createImageSync) {
        const sync = await adapter.createImageSync(key.api_key, providerModelFor(key.provider), input);
        await recordKeyUsage(key.id, true);
        await updateTask(ctx.taskId, {
          provider: key.provider,
          key_id: key.id,
          attempt: entry(key, true),
        });
        await completeTask(ctx.taskId, sync.urls);
        return { completed: true };
      }

      // مهمة غير متزامنة — إنشاء ثم تتبع داخل نافذة الانتظار
      const created = await adapter.createTask(key.api_key, providerModelFor(key.provider), input);
      await recordKeyUsage(key.id, true);
      await updateTask(ctx.taskId, {
        provider: key.provider,
        provider_task_id: created.providerTaskId,
        key_id: key.id,
        status: "processing",
        progress: 5,
        attempt: entry(key, true),
      });

      // نافذة التتبع — نافية حتى الموعد النهائي المشترك للنافذة الكلية
      while (Date.now() < ctx.deadlineMs) {
        const check = await adapter.checkTask(key.api_key, created.providerTaskId);

        if (check.status === "completed" && check.urls?.length) {
          await completeTask(ctx.taskId, check.urls);
          return { completed: true };
        }

        if (check.status === "failed") {
          const errText = check.error || "فشل التوليد";
          if (isKeyRelatedFailure(errText)) {
            // فشل مفتاح/رصيد في منتصف المهمة → نستأنف المهمة نفسها على المفتاح التالي بصمت
            const cls = classifyProviderError({ status: 402, message: errText });
            await recordKeyUsage(key.id, false, {
              errorClass: cls,
              error: errText,
              newStatus: cls === "disabled" ? "disabled" : "exhausted",
            });
            await updateTask(ctx.taskId, {
              attempt: entry(key, false, cls, errText),
              provider: null,
              provider_task_id: null,
              key_id: null,
              status: "processing",
              error_message: null,
            });
            break; // الانتقال للمفتاح التالي (نفس task_id)
          }
          // فشل حقيقي (سياسة محتوى/معاملات) → فشل نهائي
          const msg = await failTask(ctx.taskId, errText);
          return { completed: false, finalFailure: msg };
        }

        // قيد المعالجة — تحديث التقدم + إشعار تقدم كل ~3 ثوانٍ
        const elapsed = Date.now() - ctx.windowStartMs;
        const progress = Math.max(5, Math.min(95, check.progress ?? heuristicProgress(elapsed, ctx.type)));
        await updateTask(ctx.taskId, { status: "processing", progress });
        ctx.onProgress?.(progress, `⏳ جارٍ التوليد... ${progress}%`);

        const remaining = ctx.deadlineMs - Date.now();
        if (remaining <= 0) break;
        await sleep(Math.min(POLL_INTERVAL_MS, remaining));
      }

      // انتهت النافذة دون نتيجة → المهمة تبقى processing والعميل يتابع عبر get_task
      if (Date.now() >= ctx.deadlineMs) {
        return { completed: false, windowEnded: true };
      }
      continue; // مفتاح فشل في منتصف المهمة → حاول المفتاح التالي ضمن نفس النافذة (نفس task_id)
    } catch (e) {
      const cls = classifyProviderError(
        e instanceof ProviderError
          ? { status: e.status, message: e.message }
          : { status: undefined, message: e instanceof Error ? e.message : String(e) }
      );
      const errMsg = e instanceof Error ? e.message : String(e);
      await recordKeyUsage(key.id, false, {
        errorClass: cls,
        error: errMsg,
        newStatus:
          cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
      });
      await updateTask(ctx.taskId, { attempt: entry(key, false, cls, errMsg) });

      if (cls === "params") {
        // خطأ معاملات — توقف نهائي فورًا: تبديل المفتاح لن يصلح المعاملات
        const msg = await failTask(ctx.taskId, `خطأ في معاملات الطلب: ${errMsg}`);
        return { completed: false, finalFailure: msg };
      }
      // disabled / exhausted / provider / temporary → انتقل للمفتاح التالي بصمت
      continue;
    }
  }

  // فشل على كل المفاتيح → المهمة تبقى processing (وليست failed) وتُعاد المحاولة عند get_task
  await updateTask(ctx.taskId, {
    status: "processing",
    progress: 0,
    error_message: "في انتظار مفتاح صالح متاح...",
  });
  return { completed: false, allKeysFailed: true };
}

// ————— الواجهة العامة —————

export class ParamsReject extends Error {}

export interface RunGenerationResult {
  noKeys: boolean;
  task: TaskRow | null;
}

/** تشغيل توليد صورة/فيديو: تسجيل المهمة أولاً ثم تجربة المفاتيح بالترتيب ثم نافذة تتبع */
export async function runGeneration(opts: {
  type: "image" | "video";
  modelName: string;
  prompt: string;
  params: Record<string, unknown>;
  waitSeconds: number;
  onProgress?: (progress: number, message: string) => void;
}): Promise<RunGenerationResult> {
  const model = normalizeModelName(opts.modelName);
  if (!model) {
    throw new ParamsReject(`❌ نموذج غير معروف: ${opts.modelName}`);
  }

  // 1) فحص تجمع المفاتيح أولاً — إن لم توجد مفاتيح: رد no_keys (لا تسجيل للمهمة)
  const pool = await getKeyPool(model.providers);
  if (!pool.length) {
    return { noKeys: true, task: null };
  }

  // 2) تسجيل المهمة في Turso قبل أي استدعاء خارجي — تظل قابلة للتتبع حتى مع انقطاع الشبكة
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: model.canonical,
    type: opts.type,
    prompt: opts.prompt.slice(0, 2000),
    params_json: JSON.stringify(opts.params),
    status: "pending",
    progress: 0,
  });

  const wait = effectiveWaitSeconds(opts.waitSeconds);
  const ctx: GenContext = {
    taskId,
    type: opts.type,
    model,
    prompt: opts.prompt,
    params: opts.params,
    windowStartMs: Date.now(),
    deadlineMs: Date.now() + wait * 1000,
    onProgress: opts.onProgress,
  };

  const outcome = await attemptPool(ctx, pool, 0);
  void outcome;
  const task = await getTask(taskId);
  return { noKeys: false, task };
}

/** تحديث مهمة قائمة مباشرة من المزود (أو خدمة الدمج) — تُستدعى من get_task */
export async function refreshGenerationTask(task: TaskRow): Promise<TaskRow | null> {
  const lockKey = task.id;
  const existing = refreshLocks.get(lockKey);
  if (existing) return existing;

  const run = (async (): Promise<TaskRow | null> => {
    try {
      const model = normalizeModelName(task.model);

      if (task.provider && task.provider_task_id && model) {
        // المهمة مرتبطة بمزود — تحديث مباشر من المزود
        const key = task.key_id ? await getKey(task.key_id) : null;
        const adapter = ADAPTERS[task.provider];
        if (key && adapter) {
          try {
            const check = await adapter.checkTask(key.api_key, task.provider_task_id);
            if (check.status === "completed" && check.urls?.length) {
              await completeTask(task.id, check.urls);
              return getTask(task.id);
            }
            if (check.status === "failed") {
              const errText = check.error || "فشل التوليد";
              if (isKeyRelatedFailure(errText)) {
                // فشل مفتاح/رصيد → استئناف صامت على المفتاح التالي (نفس task_id)
                return await retryOnNextKey(task, model);
              }
              await failTask(task.id, errText);
              return getTask(task.id);
            }
            // قيد المعالجة
            const progress = Math.max(5, Math.min(95, check.progress ?? task.progress ?? 10));
            if (progress !== task.progress) {
              await updateTask(task.id, { status: "processing", progress });
            }
            return getTask(task.id);
          } catch (e) {
            const cls = classifyProviderError(
              e instanceof ProviderError
                ? { status: e.status, message: e.message }
                : { status: undefined, message: e instanceof Error ? e.message : String(e) }
            );
            const errMsg = e instanceof Error ? e.message : String(e);
            await recordKeyUsage(key.id, false, {
              errorClass: cls,
              error: errMsg,
              newStatus: cls === "disabled" ? "disabled" : cls === "exhausted" ? "exhausted" : undefined,
            });
            if (cls === "disabled" || cls === "exhausted") {
              return await retryOnNextKey(task, model);
            }
            // مؤقت/معاملات أثناء الفحص → نرجع المهمة كما هي (المعاودة القادمة ستتحقق)
            return getTask(task.id);
          }
        }
      }

      // لا يوجد ربط بمزود (تنتظر مفتاحًا) — راحة 45 ثانية ثم محاولة على كل المفاتيح
      const updatedMs = task.updated_at ? Date.parse(task.updated_at.replace(" ", "T") + "Z") : 0;
      const elapsed = Date.now() - (isNaN(updatedMs) ? 0 : updatedMs);
      if (elapsed < RETRY_REST_MS) return getTask(task.id);
      if (model) return await retryOnNextKey(task, model, true);
      return getTask(task.id);
    } finally {
      refreshLocks.delete(lockKey);
    }
  })();

  refreshLocks.set(lockKey, run);
  return (await run) ?? (await getTask(task.id));
}

/** استئناف المهمة نفسها (نفس task_id) على المفتاح التالي في الترتيب الصارم */
async function retryOnNextKey(
  task: TaskRow,
  model: ModelDef,
  fromStart = false
): Promise<TaskRow | null> {
  const pool = await getKeyPool(model.providers);
  if (!pool.length) {
    // لا مفاتيح الآن — تبقى processing وتُعاد المحاولة عند get_task القادم
    await updateTask(task.id, {
      status: "processing",
      provider: null,
      provider_task_id: null,
      key_id: null,
      error_message: "في انتظار مفتاح صالح متاح...",
    });
    return getTask(task.id);
  }
  // ابدأ من المفتاح التالي بعد المفتاح الفاشل (أو من البداية عند الانتظار الكامل)
  let startIndex = 0;
  if (!fromStart && task.key_id) {
    const idx = pool.findIndex((k) => k.id === task.key_id);
    startIndex = idx >= 0 ? idx + 1 : 0;
    if (startIndex >= pool.length) startIndex = 0;
  }
  // مسح الربط القديم ثم محاولة على المفاتيح (المهمة نفسها بنفس task_id)
  await updateTask(task.id, {
    provider: null,
    provider_task_id: null,
    key_id: null,
    status: "processing",
    error_message: null,
  });
  // عند الاستئناف عبر get_task لا ننتظر نافذة طويلة — إنشاء/فحص سريع فقط (نافذة قصيرة 15 ثانية)
  const ctx: GenContext = {
    taskId: task.id,
    type: task.type === "image" ? "image" : "video",
    model,
    prompt: task.prompt,
    params: safeParseParams(task.params_json),
    windowStartMs: Date.now(),
    deadlineMs: Date.now() + 15_000,
  };
  await attemptPool(ctx, pool, startIndex);
  return getTask(task.id);
}

function safeParseParams(json: string | null): Record<string, unknown> {
  try {
    return JSON.parse(json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ————— التنسيق العربي لردود الأدوات —————

export function formatTaskMessage(task: TaskRow | null): string {
  if (!task) return "❌ المهمة غير موجودة";
  const urls = parseUrls(task.result_urls_json);

  if (task.status === "completed") {
    if (task.type === "image") {
      const lines = ["✅ تم إنشاء الصورة بنجاح", ""];
      for (const u of urls) {
        lines.push(`![image](${u})`);
        lines.push(`الرابط المباشر: ${u}`);
      }
      return lines.join("\n");
    }
    if (task.type === "video") {
      const lines = ["✅ تم إنشاء الفيديو بنجاح", ""];
      for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
      return lines.join("\n");
    }
    // merge
    const lines = ["✅ تم دمج المقاطع بنجاح", ""];
    for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
    lines.push("");
    lines.push("⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
    return lines.join("\n");
  }

  if (task.status === "failed") {
    return `❌ فشلت المهمة: ${task.error_message || "سبب غير معروف"}`;
  }

  // pending | processing
  const progressLine = task.progress > 0 ? ` (التقدم: ${task.progress}%)` : "";
  return [
    `⏳ المهمة قيد المعالجة${progressLine} — task_id: ${task.id}`,
    "",
    "تابع باستخدام get_task كل ~10 ثوانٍ حتى الاكتمال.",
  ].join("\n");
}

export function parseUrls(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? (arr as string[]) : [];
  } catch {
    return [];
  }
}
