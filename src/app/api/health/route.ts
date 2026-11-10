// فحص الصحة: قاعدة البيانات + النماذج + توفر خدمة الدمج + حالة المصادقة
import { dbHealthy } from "@/lib/turso";
import { modelsSummary } from "@/lib/models";
import { mergerHealthy, mergerBase } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const healthy = await dbHealthy();
  const mergerOk = await mergerHealthy();

  return Response.json(
    {
      ok: healthy,
      database: healthy ? "turso-connected" : "turso-error",
      mcpEndpoint: "/mcp",
      models: modelsSummary(),
      merger: { base: mergerBase(), healthy: mergerOk },
      authRequired: !!process.env.MCP_ACCESS_TOKEN,
    },
    { status: 200 }
  );
}
