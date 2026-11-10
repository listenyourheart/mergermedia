// قائمة المهام الأخيرة + الإحصاءات — للوحة المهام في الواجهة (تحديث تلقائي كل ~5 ثوانٍ)
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 50);
    const type = url.searchParams.get("type") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;

    const tasks = await listRecentTasks(limit, {
      type: type && ["image", "video", "merge"].includes(type) ? type : undefined,
      status: status && ["completed", "failed", "processing"].includes(status) ? status : undefined,
    });
    const stats = await taskStats();

    const mapped = tasks.map((t) => ({
      id: t.id,
      type: t.type,
      model: t.model,
      status: t.status,
      progress: t.progress,
      prompt: t.prompt?.slice(0, 120) ?? "",
      resultUrls: (() => {
        try {
          const arr = JSON.parse(t.result_urls_json ?? "[]") as string[];
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      })(),
      errorMessage: t.error_message,
      attempts: (() => {
        try {
          const arr = JSON.parse(t.attempts_json ?? "[]") as unknown[];
          return Array.isArray(arr) ? arr.length : 0;
        } catch {
          return 0;
        }
      })(),
      createdAt: t.created_at,
      completedAt: t.completed_at,
    }));

    return Response.json({ ok: true, tasks: mapped, stats });
  } catch (e) {
    return Response.json(
      { ok: false, error: "تعذر جلب المهام", detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
