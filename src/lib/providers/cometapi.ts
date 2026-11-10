// محوّل CometAPI — مزود ثانوي
// الصور: نقطة نهاية متوافقة مع OpenAI (مزامنة): POST /v1/images/generations → {data:[{url|b64_json}]}
// الفيديو: مهام غير متزامنة: POST /v1/videos → {id} ثم GET /v1/videos/{id} → {status, progress}
// ملاحظة: لم يُختبر بمفتاح حقيقي بعد (لا يوجد مفتاح CometAPI لدى المستخدم) — التحليل دفاعي وفق توثيق api.cometapi.com
import {
  ProviderAdapter,
  ProviderError,
  NetworkError,
  type CheckResult,
} from "./types";

const BASE = "https://api.cometapi.com/v1";
const TIMEOUT_MS = 30_000;

async function callComet(
  path: string,
  apiKey: string,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (!res.ok) {
    const errObj = body.error as Record<string, unknown> | string | undefined;
    const msg =
      (typeof errObj === "object" && errObj && typeof errObj.message === "string"
        ? errObj.message
        : typeof errObj === "string"
          ? errObj
          : null) ||
      (typeof body.message === "string" ? body.message : null) ||
      `CometAPI HTTP ${res.status}`;
    throw new ProviderError(res.status, msg);
  }
  return body;
}

export const cometApiAdapter: ProviderAdapter = {
  // صور متزامنة — النتيجة تعود فورًا (رابط أو b64_json)
  async createImageSync(apiKey, providerModel, input) {
    const prompt = String(input.prompt ?? "");
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt,
      n: 1,
    };
    // خيارات داعمة إن وُجدت (متوافقة مع OpenAI)
    if (typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto") {
      payload.size = input.aspect_ratio === "1:1" ? "1024x1024" : "1536x1024";
    }
    if (input.output_format) payload.output_format = input.output_format;
    if (input.background && input.background !== "auto") payload.background = input.background;

    const body = await callComet("/images/generations", apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = body.data as Array<Record<string, unknown>> | undefined;
    const urls: string[] = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item.url === "string" && item.url) {
          urls.push(item.url);
        } else if (typeof item.b64_json === "string" && item.b64_json) {
          // نُعيد data URI ذاتي الاحتواء (لا نرفع أي ملف على خادمنا — قاعدة ذهبية)
          urls.push(`data:image/png;base64,${item.b64_json}`);
        }
      }
    }
    if (!urls.length) {
      throw new ProviderError(500, "CometAPI أعاد ردًا بلا روابط صور");
    }
    return { urls };
  },

  async createTask(apiKey, providerModel, input) {
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt: String(input.prompt ?? ""),
    };
    if (Array.isArray(input.image_urls) && input.image_urls.length) {
      payload.image_url = input.image_urls[0];
    }
    // CometAPI يستخدم "seconds" لمدة الفيديو وفق توثيقهم
    if (typeof input.duration === "number") payload.seconds = input.duration;
    if (typeof input.aspect_ratio === "string" && input.aspect_ratio !== "auto") {
      payload.aspect_ratio = input.aspect_ratio;
    }

    const body = await callComet("/videos", apiKey, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const taskId =
      (typeof body.id === "string" && body.id) ||
      (typeof body.task_id === "string" && body.task_id) ||
      ((body.data as Record<string, unknown> | undefined)?.id as string | undefined) ||
      null;
    if (!taskId) throw new ProviderError(500, "CometAPI لم يعرف معرف مهمة الفيديو");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const body = await callComet(`/videos/${encodeURIComponent(providerTaskId)}`, apiKey);
    const statusRaw = String(body.status ?? body.state ?? "").toLowerCase();
    const progress =
      typeof body.progress === "number" ? Math.max(0, Math.min(100, body.progress)) : undefined;

    // حالات موثقة: queued | in_progress | completed | failed | error
    if (["completed", "succeeded", "success", "done"].includes(statusRaw)) {
      // استخراج دفاعي للرابط من صيغ مختلفة محتملة
      const urls: string[] = [];
      const candidates = [
        body.video_url,
        body.url,
        body.result_url,
        (body.data as Record<string, unknown> | undefined)?.video_url,
        (body.data as Record<string, unknown> | undefined)?.url,
      ];
      for (const c of candidates) {
        if (typeof c === "string" && /^https?:\/\//.test(c)) urls.push(c);
      }
      if (!urls.length) {
        // محتوى الفيديو عبر نقطة النهاية الموثقة
        urls.push(`${BASE}/videos/${providerTaskId}/content`);
      }
      return { status: "completed", urls };
    }
    if (["failed", "error", "cancelled"].includes(statusRaw)) {
      const msg = typeof body.error === "string" ? body.error : "فشل التوليد لدى CometAPI";
      return { status: "failed", error: msg };
    }
    return { status: "processing", progress };
  },
};
