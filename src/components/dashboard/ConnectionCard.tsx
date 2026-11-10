'use client'

// بطاقة الاتصال بالخادم — رابط MCP + JSON جاهز للنسخ لكل عميل + شرائح الأدوات + ملاحظة التوقيت
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { HealthInfo } from "@/app/page";

const TABS = [
  { id: "chatgpt", label: "ChatGPT / GPT Agents" },
  { id: "claude", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor / Windsurf / Cline" },
] as const;

const TOOL_CHIPS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "إنشاء صورة من وصف نصي — تعيد الرابط مباشرة أو task_id للتتبع" },
  { name: "generate_video", desc: "إنشاء فيديو بصوت متزامن (حوارات/مؤثرات/موسيقى) مع دعم صورة إطار أول" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب — urls أو task_ids" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرفها — استعلم كل ~10 ثوانٍ حتى الاكتمال" },
  { name: "list_media", desc: "عرض آخر الوسائط المخزنة بروابطها من قاعدة البيانات" },
];

export default function ConnectionCard({ health }: { health: HealthInfo | null }) {
  // عنوان URL المطلق يُبنى في المتصفح بعد الترطيب فقط لتجنب اختلاف أثناء العرض على الخادم
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = `${origin || "https://<your-deployment>"}/mcp`;
  const authRequired = health?.authRequired === true;
  const tokenHint = authRequired
    ? "    \"headers\": { \"Authorization\": \"Bearer <MCP_ACCESS_TOKEN>\" }"
    : null;

  const chatgptJson = useMemo(() => {
    const inner = `"url": "${mcpUrl}"`;
    const withAuth = authRequired
      ? `{\n  "mcpServers": {\n    "media-generator": {\n      ${inner},\n      "headers": {\n        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"\n      }\n    }\n  }\n}`
      : `{\n  "mcpServers": {\n    "media-generator": {\n      ${inner}\n    }\n  }\n}`;
    return withAuth;
  }, [mcpUrl, authRequired]);

  const claudeJson = useMemo(() => {
    const withAuth = authRequired
      ? `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}",\n      "headers": {\n        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"\n      }\n    }\n  }\n}`
      : `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"\n    }\n  }\n}`;
    return withAuth;
  }, [mcpUrl, authRequired]);

  const cursorJson = useMemo(() => {
    const withAuth = authRequired
      ? `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}",\n      "headers": {\n        "Authorization": "Bearer <MCP_ACCESS_TOKEN>"\n      }\n    }\n  }\n}`
      : `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"\n    }\n  }\n}`;
    return withAuth;
  }, [mcpUrl, authRequired]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // المتصفح قد يمنع النسخ — لا شيء نقوم به
    }
  };

  const activeJson = tab === "chatgpt" ? chatgptJson : tab === "claude" ? claudeJson : cursorJson;

  return (
    <Card className="border-white/10 bg-white/[0.03] backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-extrabold">
          🔌 الاتصال بالخادم
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* رابط MCP */}
        <div className="flex gap-2">
          <Input
            readOnly
            dir="ltr"
            value={mcpUrl}
            className="border-white/15 bg-[#0d1428] font-mono text-sm text-cyan-300"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            onClick={() => copy(mcpUrl, "url")}
            className="shrink-0 bg-gradient-to-l from-cyan-600 to-violet-600 font-bold text-white hover:from-cyan-500 hover:to-violet-500"
          >
            {copied === "url" ? "✓ تم النسخ" : "نسخ"}
          </Button>
        </div>

        {/* التبويبات الثلاثة */}
        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                tab === t.id
                  ? "bg-gradient-to-l from-cyan-600 to-violet-600 text-white shadow-md shadow-violet-900/40"
                  : "bg-white/[0.06] text-slate-300 hover:bg-white/10"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "chatgpt" && (
          <p className="text-xs leading-relaxed text-slate-400">
            في ChatGPT: <span dir="ltr">Settings → Connectors → Create → Custom MCP server</span> ثم ضع
            الرابط في خانة <span dir="ltr">Server URL</span>.
          </p>
        )}
        {tab === "claude" && (
          <p className="text-xs leading-relaxed text-slate-400">
            أضف الكتلة التالية إلى ملف <span dir="ltr">claude_desktop_config.json</span> ثم أعد تشغيل
            التطبيق.
          </p>
        )}
        {tab === "cursor" && (
          <p className="text-xs leading-relaxed text-slate-400">
            أضف الكتلة التالية إلى ملف <span dir="ltr">mcp.json</span> في Cursor أو Windsurf أو Cline.
          </p>
        )}

        <div className="relative">
          <pre
            dir="ltr"
            className="custom-scrollbar max-h-64 overflow-auto rounded-xl border border-white/10 bg-[#0d1428] p-4 font-mono text-xs leading-relaxed text-emerald-300"
          >
            {activeJson}
          </pre>
          <Button
            size="sm"
            onClick={() => copy(activeJson, "json")}
            className="absolute left-2 top-2 h-8 border-white/15 bg-white/10 px-2.5 text-xs text-slate-200 hover:bg-white/20"
          >
            {copied === "json" ? "✓ نُسخ" : "نسخ JSON"}
          </Button>
        </div>

        {/* شرائح الأدوات الخمسة */}
        <div>
          <p className="mb-2 text-xs font-bold text-slate-400">الأدوات الخمسة المتاحة:</p>
          <div className="flex flex-wrap gap-2">
            {TOOL_CHIPS.map((t) => (
              <Badge
                key={t.name}
                title={t.desc}
                className="max-w-full cursor-help border-0 bg-violet-500/15 py-1 text-[11px] font-semibold text-violet-200 ring-1 ring-violet-500/30"
              >
                <span dir="ltr" className="font-mono">{t.name}</span>
                <span className="ms-1.5 hidden sm:inline">— {t.desc}</span>
              </Badge>
            ))}
          </div>
        </div>

        {/* ملاحظة ambre عن توقيت الفيديو */}
        <p className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200 ring-1 ring-amber-500/30">
          ⏳ الفيديو يستغرق دقائق: يعيد الخادم فورًا task_id، ويتم التتبع تلقائيًا عبر get_task كل 10
          ثوانٍ — وبمجرد اكتمال المهمة يظهر الرابط في المحادثة ويتوقف الاستعلام. أثناء الانتقال يُبث
          تقدم مباشر (Progress notifications) حتى لا تنقطع العملية.
        </p>
      </CardContent>
    </Card>
  );
}
