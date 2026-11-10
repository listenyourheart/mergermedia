// سجل النماذج — الأسماء الثابتة كما تُرى من عميل MCP + الاسم المُرسل لكل مزود
// تقبل صيغًا بديلة بالنقاط (2.6 / 1.5) وتوحّدها، وتسمح بالتجاوز عبر متغيرات البيئة
export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة مقبولة (تُوحَّد داخليًا)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب كل مفاتيحه بالترتيب
  providerModel: Record<ProviderId, string>; // اسم النموذج كما يُرسل لكل مزود
}

// أسماء قابلة للتجاوز عبر متغيرات البيئة
const KIE_IMAGE = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE =
  process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare-text-to-image";
const COMETAPI_VIDEO =
  process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1-5-preview";

function withAliases(canonical: string): string[] {
  // صيغة بديلة بالنقاط بدل الشرطات (مثل: gpt-image-2.6/...)
  const dotted = canonical.replace(/-/g, ".");
  // توحيد الشائع: 2-6 ← 2.6 و 1-5 ← 1.5
  const alt = canonical.replace(/(\d)-(\d)/g, "$1.$2");
  return Array.from(new Set([dotted, alt])).filter((a) => a !== canonical);
}

export const MODELS: ModelDef[] = [
  {
    canonical: KIE_IMAGE,
    aliases: withAliases(KIE_IMAGE),
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE, cometapi: COMETAPI_IMAGE },
  },
  {
    canonical: KIE_VIDEO,
    aliases: withAliases(KIE_VIDEO),
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO, cometapi: COMETAPI_VIDEO },
  },
];

/** توحيد اسم النموذج: نقاط ↔ شرطات ثم مطابقة الاسم الأساسي أو الأسماء البديلة */
export function normalizeModelName(input: string | undefined | null): ModelDef | null {
  if (!input) return null;
  const norm = (s: string) => s.trim().toLowerCase().replace(/\./g, "-");
  const target = norm(input);
  for (const m of MODELS) {
    if (norm(m.canonical) === target) return m;
    if (m.aliases.some((a) => norm(a) === target)) return m;
  }
  return null;
}

/** ملخص النماذج لفحص الصحة /health */
export function modelsSummary() {
  return MODELS.map((m) => ({
    canonical: m.canonical,
    type: m.type,
    providers: m.providers,
  }));
}
