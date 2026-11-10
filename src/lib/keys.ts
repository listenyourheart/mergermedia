// طبقة إدارة المفاتيح — الإخفاء الإلزامي (maskKey) في كل الردود والسجلات
// لا تُعرض المفتاح الكامل في أي رد إطلاقًا
import { randomUUID } from "crypto";
import {
  insertKey,
  listKeys,
  keyExists,
  patchKey as dbPatchKey,
  deleteKey as dbDeleteKey,
  getKey,
  type KeyRow,
} from "./turso";

export const KEY_PROVIDERS = ["kie", "cometapi"] as const;
export type KeyProviderId = (typeof KEY_PROVIDERS)[number];

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 — وللمفاتيح القصيرة: أول 3 + •••• */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length >= 14) return key.slice(0, 7) + "••••••••" + key.slice(-4);
  return key.slice(0, 3) + "••••";
}

/** صف مفتاح آمن للعرض (المفتاح مخفي دائمًا) */
export function publicKey(k: KeyRow) {
  return {
    id: k.id,
    provider: k.provider,
    label: k.label,
    maskedKey: maskKey(k.api_key),
    status: k.status,
    usageCount: k.usage_count,
    successCount: k.success_count,
    failCount: k.fail_count,
    lastUsedAt: k.last_used_at,
    lastCheckedAt: k.last_checked_at,
    lastError: k.last_error,
    createdAt: k.created_at,
  };
}

export async function listPublicKeys() {
  const keys = await listKeys();
  return keys.map(publicKey);
}

/** إضافة مفتاح جديد مع رفض المكرر لنفس المزود */
export async function addKey(provider: string, apiKey: string, label?: string) {
  provider = String(provider || "").trim();
  apiKey = String(apiKey || "").trim();
  if (!KEY_PROVIDERS.includes(provider as KeyProviderId)) {
    return { ok: false as const, code: 400, error: "❌ المزود غير صالح. القيم المسموحة: kie أو cometapi" };
  }
  if (!apiKey) {
    return { ok: false as const, code: 400, error: "❌ المفتاح مطلوب" };
  }
  if (await keyExists(provider, apiKey)) {
    return {
      ok: false as const,
      code: 409,
      error: "❌ هذا المفتاح مضاف مسبقًا لنفس المزود — لا يمكن تكرار المفاتيح",
    };
  }
  const id = randomUUID();
  await insertKey({ id, provider, label: (label || "").trim(), api_key: apiKey });
  const row = await getKey(id);
  return { ok: true as const, key: row ? publicKey(row) : null };
}

/** تعطيل/تفعيل يدوي */
export async function setKeyStatus(id: string, status: "active" | "disabled" | "exhausted") {
  const row = await dbPatchKey(id, { status });
  return row ? publicKey(row) : null;
}

export async function removeKey(id: string) {
  return dbDeleteKey(id);
}
