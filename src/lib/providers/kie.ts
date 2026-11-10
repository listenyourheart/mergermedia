// محوّل kie.ai — Jobs API الموحد (تم التحقق من الصيغ من docs.kie.ai الرسمية)
// createTask: POST /api/v1/jobs/createTask → {"code":200,"data":{"taskId":"..."}}
// recordInfo: GET  /api/v1/jobs/recordInfo?taskId=... → data.state + resultJson (نص JSON داخل JSON يتطلب JSON.parse ثاني)
import {
  ProviderAdapter,
  ProviderError,
  NetworkError,
  type CheckResult,
} from "./types";

const BASE = "https://api.kie.ai";

/** مهلة افتراضية 30 ثانية لكل استدعاء مزود */
const TIMEOUT_MS = 30_000;

async function callKie(
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
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // انقطاع شبكة/مهلة → مؤقت
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // kie قد يعيد HTTP 200 مع رمز خطأ داخلي في حقل code → نطبّعه
  const internalCode = typeof body.code === "number" ? body.code : undefined;
  const status = res.status !== 200 ? res.status : internalCode;
  const msg =
    (typeof body.msg === "string" && body.msg) ||
    extractDeepMessage(body) ||
    `kie.ai HTTP ${res.status}`;

  if (res.status !== 200 || (internalCode !== undefined && internalCode !== 200)) {
    throw new ProviderError(status ?? res.status, msg);
  }
  return body;
}

function extractDeepMessage(body: Record<string, unknown>): string | null {
  const data = body.data as Record<string, unknown> | undefined;
  if (data && typeof data.failMsg === "string" && data.failMsg) return data.failMsg;
  if (body.error && typeof body.error === "object") {
    const err = body.error as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
  }
  if (typeof body.error === "string") return body.error;
  return null;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(apiKey, providerModel, input) {
    const body = await callKie("/api/v1/jobs/createTask", apiKey, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    const data = body.data as { taskId?: string } | undefined;
    const taskId = data?.taskId;
    if (!taskId) {
      throw new ProviderError(500, "kie.ai لم يعرف معرف المهمة في الرد");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(apiKey, providerTaskId): Promise<CheckResult> {
    const body = await callKie(
      `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      apiKey
    );
    const data = body.data as Record<string, unknown> | undefined;
    if (!data) throw new NetworkError("kie.ai رد بلا حقل data");

    const state = String(data.state ?? "");
    // resultJson نص JSON داخل JSON — يحتاج JSON.parse ثاني (تم توثيق ذلك)
    let urls: string[] = [];
    if (typeof data.resultJson === "string" && data.resultJson) {
      try {
        const parsed = JSON.parse(data.resultJson) as { resultUrls?: string[] };
        urls = Array.isArray(parsed.resultUrls) ? parsed.resultUrls : [];
      } catch {
        // إذا تغيرت الصيغة لاحقًا: نتجاهل ولا نبتكر حقولًا
        urls = [];
      }
    }

    const failMsg = typeof data.failMsg === "string" ? data.failMsg : "";
    const progress =
      typeof data.progress === "number" ? Math.max(0, Math.min(100, data.progress)) : undefined;

    if (state === "success") {
      return { status: "completed", urls };
    }
    if (state === "fail") {
      return { status: "failed", error: failMsg || "فشل التوليد لدى kie.ai" };
    }
    // waiting | queuing | generating → قيد المعالجة
    return { status: "processing", progress };
  },
};
