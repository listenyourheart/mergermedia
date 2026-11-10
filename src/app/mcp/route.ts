// مسار MCP — نقل Streamable HTTP وفق مواصفات MCP عبر SDK الرسمي
// runtime=nodejs + force-dynamic إلزاميان؛ الوضع عديم الحالة (stateless) متوافق مع Serverless
// إذا ضُبط MCP_ACCESS_TOKEN فمطلوب Authorization: Bearer <token> على المسار
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer, KNOWN_TOOLS } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// مهلة الدالة على Vercel — بعد نافذة الانتظار يعيد العميل التتبع عبر get_task
export const maxDuration = 60;

/** تحقق اختياري من رمز الوصول */
function checkAuth(req: Request): Response | null {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return null; // لا مصادقة مطلوبة
  const header = req.headers.get("authorization") || "";
  if (header !== `Bearer ${token}`) {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" }, id: null }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }
  return null;
}

/** بناء زوج خادم + نقل جديد لكل طلب (stateless) */
async function handleWithTransport(req: Request): Promise<Response> {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // عديم الحالة — مناسب لبيئات Serverless
    enableJsonResponse: false, // بث SSE لدعم إشعارات التقدم الحية
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}

/** رد نتيجة أداة مباشرة بصيغة JSON-RPC (يُستخدم لرسائل عربية نظيفة خارج النقل) */
function toolResultResponse(id: unknown, result: unknown): Response {
  const envelope =
    id !== undefined ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", result };
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(req: Request) {
  const authError = checkAuth(req);
  if (authError) return authError;

  // قراءة الجسم مرة واحدة: لفحص الأداة غير المعروفة (رسالة عربية) قبل تمريره للنقل
  const bodyText = await req.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }

  // أداة غير معروفة → رد JSON-RPC نتيجة برسالة عربية (بدل خطأ إنجليزي من SDK)
  const p = parsed as {
    method?: string;
    id?: unknown;
    params?: { name?: string; arguments?: Record<string, unknown> };
  } | null;
  if (
    p &&
    typeof p === "object" &&
    p.method === "tools/call" &&
    typeof p.params?.name === "string" &&
    !KNOWN_TOOLS.includes(p.params.name as (typeof KNOWN_TOOLS)[number])
  ) {
    const result = {
      content: [
        {
          type: "text",
          text: `❌ أداة غير معروفة: ${p.params.name}. المتاحة: ${KNOWN_TOOLS.join(", ")}`,
        },
      ],
      isError: true,
    };
    return toolResultResponse(p.id, result);
  }

  // رفض دمج بمقاطع غير صالحة (أقل من 2 أو أكثر من 10) برسالة عربية نظيفة قبل تحقق النقل
  if (
    p &&
    typeof p === "object" &&
    p.method === "tools/call" &&
    p.params?.name === "merge_videos" &&
    p.params.arguments
  ) {
    const urls = Array.isArray(p.params.arguments.urls) ? (p.params.arguments.urls as unknown[]) : [];
    const taskIds = Array.isArray(p.params.arguments.task_ids)
      ? (p.params.arguments.task_ids as unknown[])
      : [];
    for (const arr of [urls, taskIds]) {
      if (arr.length > 0 && arr.length < 2) {
        return toolResultResponse(p.id, {
          content: [
            {
              type: "text",
              text: "❌ الدمج يتطلب مقطعين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
            },
          ],
          isError: true,
        });
      }
      if (arr.length > 10) {
        return toolResultResponse(p.id, {
          content: [
            {
              type: "text",
              text: "❌ الحد الأقصى لمقاطع الدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).",
            },
          ],
          isError: true,
        });
      }
    }
  }

  // إعادة بناء الطلب بالجسم المقروء ثم تمريره للنقل الرسمي
  const rebuilt = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: bodyText,
  });
  return handleWithTransport(rebuilt);
}

export async function GET(req: Request) {
  const authError = checkAuth(req);
  if (authError) return authError;
  // GET لفتح مجرى SSE من الخادم — في الوضع عديم الحالة يرفضه النقل تلقائيًا (405)
  return handleWithTransport(req);
}

export async function DELETE(req: Request) {
  const authError = checkAuth(req);
  if (authError) return authError;
  // DELETE لإنهاء الجلسة — لا جلسات في الوضع عديم الحالة
  return handleWithTransport(req);
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, MCP-Protocol-Version",
    },
  });
}
