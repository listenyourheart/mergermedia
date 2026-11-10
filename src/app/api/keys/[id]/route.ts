// تعديل مفتاح (تعطيل/تفعيل يدوي) أو حذفه — المفتاح الكامل لا يُعاد أبدًا
import { setKeyStatus, removeKey, publicKey } from "@/lib/keys";
import { getKey } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  let body: { status?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: "جسم الطلب غير صالح" }, { status: 400 });
  }
  const status = body.status;
  if (status !== "active" && status !== "disabled") {
    return Response.json(
      { ok: false, error: "❌ الحالة المسموحة: active أو disabled (التعطيل اليدوي هو الاستثناء الوحيد من الترتيب)" },
      { status: 400 }
    );
  }
  const existing = await getKey(id);
  if (!existing) {
    return Response.json({ ok: false, error: "❌ المفتاح غير موجود" }, { status: 404 });
  }
  const updated = await setKeyStatus(id, status);
  return Response.json({ ok: true, key: updated });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const removed = await removeKey(id);
  if (!removed) {
    return Response.json({ ok: false, error: "❌ المفتاح غير موجود" }, { status: 404 });
  }
  return Response.json({ ok: true, deleted: id });
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const row = await getKey(id);
  if (!row) {
    return Response.json({ ok: false, error: "❌ المفتاح غير موجود" }, { status: 404 });
  }
  return Response.json({ ok: true, key: publicKey(row) });
}
