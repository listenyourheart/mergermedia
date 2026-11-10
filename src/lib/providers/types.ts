// أنواع مشتركة لمحوّلات المزودين — كل خطأ يُرمى كـ ProviderError ويُصنَّف لاحقًا بواسطة classify.ts
export interface CreateResult {
  providerTaskId: string;
}

export interface CheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100 إن وفره المزود
}

export interface ProviderAdapter {
  /** مهمة غير متزامنة (الفيديو وبعض الصور): تُعيد معرف المهمة لدى المزود */
  createTask(
    apiKey: string,
    providerModel: string,
    input: Record<string, unknown>
  ): Promise<CreateResult>;

  /** صور متزامنة إن دعمها المزود (CometAPI يعيد النتيجة فورًا) */
  createImageSync?(
    apiKey: string,
    providerModel: string,
    input: Record<string, unknown>
  ): Promise<{ urls: string[] }>;

  /** استعلام حالة مهمة قائمة */
  checkTask(apiKey: string, providerTaskId: string): Promise<CheckResult>;
}

/** خطأ مزود — الحقل status هو رمز HTTP أو رمز الخطأ الداخلي للمزود */
export class ProviderError extends Error {
  status: number | undefined;
  constructor(status: number | undefined, message: string) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

/** مهلة أو انقطاع شبكة — يُصنَّف دائمًا temporary */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}
