// تصنيف موحّد لأخطاء المزودين — يحدد إجراء التبديل بين المفاتيح حسب الجدول في المواصفات
// الترتيب مهم: فحص الاستنفاد قبل 400/422 لأن بعض المزودين يرسلون استنفاد الرصيد برمز 400
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export interface ProviderErrorShape {
  status?: number; // رمز HTTP أو رمز الخطأ الداخلي للمزود
  message: string;
}

const AUTH_RE =
  /invalid api key|unauthorized|forbidden|authentication|invalid.*key|api key.*invalid|missing api key/i;
const EXHAUSTED_RE =
  /insufficient|quota|balance|credit|out of credits|exhausted|充值|no credit|insufficient balance|payment/i;
const MODEL_RE = /model not found|unsupported model|unknown model|model does not exist|not a valid model/i;

/**
 * تصنيف الخطأ:
 * - disabled  : 401/403 أو رسائل مفتاح غير صالح → عطّل المفتاح تلقائيًا وانتقل للتالي
 * - exhausted : 402 أو رسائل استنفاد الرصيد (يُفحص قبل 400!) → علّم المفتاح مستنفدًا وانتقل
 * - provider  : "model not found / unsupported model" مع 400/404/422 → انتقل للمفتاح التالي
 * - params    : 400/422 (بعد استبعاد الاستنفاد والنموذج) → توقف فورًا (تبديل المفتاح لن يصلح المعاملات)
 * - temporary : 429، 5xx، انقطاع الشبكة، مهلة → انتقل للتالي الآن (المفتاح سليم)
 */
export function classifyProviderError(err: ProviderErrorShape): ErrorClass {
  const status = typeof err.status === "number" ? err.status : undefined;
  const msg = String(err.message ?? "");

  // 1) مفتاح مرفوض
  if (status === 401 || status === 403) return "disabled";
  if (AUTH_RE.test(msg)) return "disabled";

  // 2) استنفاد الرصيد — قبل فحص 400 لأن بعض المزودين يرسلونه برمز 400
  if (status === 402) return "exhausted";
  if (status === 433) return "exhausted"; // رمز kie.ai: تجاوز حد الاستخدام للمفتاح الفرعي
  if (EXHAUSTED_RE.test(msg)) return "exhausted";

  // 3) نموذج غير مدعوم لدى هذا المزود
  if (MODEL_RE.test(msg) && (status === 400 || status === 404 || status === 422 || status === undefined)) {
    return "provider";
  }

  // 4) خطأ معاملات — توقف نهائي
  if (status === 400 || status === 422) return "params";
  if (status === 404) return "provider"; // نقطة نهاية/مورد غير موجود → جرّب المفتاح التالي

  // 5) مؤقت: 429 و 5xx وما بعدها
  if (status === 429) return "temporary";
  if (status !== undefined && status >= 500) return "temporary";

  // بدون رمز واضح (انقطاع شبكة/مهلة/رفض اتصال) → مؤقت
  return "temporary";
}

/**
 * كشف فشل مهمة قائمة بسبب مشكلة مفتاح/رصيد أثناء التتبع — يستوجب إعادة إنشاء المهمة نفسها على المفتاح التالي
 * (حسب المواصفات 4.3.2: insufficient|balance|credit|quota|402|401|unauthorized)
 */
export function isKeyRelatedFailure(message: string): boolean {
  if (!message) return false;
  return (
    /insufficient|balance|credit|quota|402|401|unauthorized|exhausted|充值|forbidden|invalid api key/i.test(
      message
    )
  );
}
