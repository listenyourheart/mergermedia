// إدارة المفاتيح: قائمة مخفية بالكامل + إضافة مع رفض المكرر
import { addKey, listPublicKeys } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const keys = await listPublicKeys();
    return Response.json({ ok: true, keys });
  } catch (e) {
    return Response.json(
      { ok: false, error: "تعذر جلب المفاتيح من قاعدة البيانات", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  let body: { provider?: string; api_key?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "جسم الطلب غير صالح" }, { status: 400 });
  }
  try {
    const result = await addKey(body.provider ?? "", body.api_key ?? "", body.label);
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: result.code });
    }
    return Response.json({ ok: true, key: result.key }, { status: 201 });
  } catch (e) {
    return Response.json(
      { ok: false, error: "تعذر حفظ المفتاح", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
