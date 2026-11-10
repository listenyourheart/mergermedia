'use client'

// بطاقة لوحة المهام — بطاقات إحصاء + قائمة مهام تُحدَّث تلقائيًا كل ~5 ثوانٍ
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface TaskItem {
  id: string;
  type: string;
  model: string;
  status: string;
  progress: number;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attempts: number;
  createdAt: string | null;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  completed: { label: "مكتملة", className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40" },
  failed: { label: "فاشلة", className: "bg-red-500/15 text-red-300 ring-red-500/40" },
  processing: { label: "قيد المعالجة", className: "bg-cyan-500/15 text-cyan-300 ring-cyan-500/40" },
  pending: { label: "بالانتظار", className: "bg-slate-500/15 text-slate-300 ring-slate-500/40" },
};

const TYPE_LABEL: Record<string, string> = {
  image: "صورة",
  video: "فيديو",
  merge: "دمج",
};

export default function TasksPanel() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [stats, setStats] = useState<Stats>({ total: 0, completed: 0, failed: 0, processing: 0 });

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const data = (await res.json()) as { ok: boolean; tasks: TaskItem[]; stats: Stats };
      if (data.ok) {
        setTasks(data.tasks);
        setStats(data.stats);
      }
    } catch {
      // تجاهل أخطاء التحديث الخلفي
    }
  }, []);

  useEffect(() => {
    load();
    // تحديث تلقائي كل 5 ثوانٍ
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [load]);

  const statCards = [
    { label: "الإجمالي", value: stats.total, cls: "text-slate-200", ring: "ring-white/15" },
    { label: "مكتملة", value: stats.completed, cls: "text-emerald-300", ring: "ring-emerald-500/40" },
    { label: "فاشلة", value: stats.failed, cls: "text-red-300", ring: "ring-red-500/40" },
    { label: "قيد المعالجة", value: stats.processing, cls: "text-cyan-300", ring: "ring-cyan-500/40" },
  ];

  return (
    <Card className="border-white/10 bg-white/[0.03] backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-extrabold">
          📊 لوحة المهام
          <span className="text-[11px] font-medium text-slate-500">(تحديث تلقائي كل 5 ثوانٍ)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* بطاقات الإحصاء */}
        <div className="grid grid-cols-4 gap-2">
          {statCards.map((s) => (
            <div
              key={s.label}
              className={`rounded-xl bg-white/[0.04] p-3 text-center ring-1 ${s.ring}`}
            >
              <p className={`text-xl font-extrabold ${s.cls}`}>{s.value}</p>
              <p className="mt-0.5 text-[11px] text-slate-400">{s.label}</p>
            </div>
          ))}
        </div>

        {/* قائمة المهام الحديثة */}
        {tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/15 p-4 text-center text-xs text-slate-500">
            لا توجد مهام بعد — أول عملية توليد ستظهر هنا مباشرة
          </p>
        ) : (
          <ul className="custom-scrollbar max-h-96 space-y-3 overflow-y-auto pl-1">
            {tasks.map((t) => {
              const badge = STATUS_BADGE[t.status] ?? STATUS_BADGE.pending;
              return (
                <li
                  key={t.id}
                  className="rounded-xl border border-white/10 bg-[#0d1428] p-3 transition hover:border-cyan-500/40"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className={`border-0 text-[11px] font-bold ring-1 ${badge.className}`}>
                        {badge.label}
                      </Badge>
                      <span className="text-[11px] font-bold text-slate-300">
                        {TYPE_LABEL[t.type] ?? t.type}
                      </span>
                      <span dir="ltr" className="max-w-[220px] truncate text-[11px] text-slate-500">
                        {t.model}
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-500" title={t.createdAt ?? ""}>
                      {t.createdAt?.slice(0, 16).replace("T", " ") || "-"}
                    </span>
                  </div>

                  {t.prompt && (
                    <p className="mt-1.5 truncate text-xs text-slate-300" title={t.prompt}>
                      {t.prompt}
                    </p>
                  )}

                  {(t.status === "processing" || t.status === "pending") && (
                    <div className="mt-2 flex items-center gap-2">
                      <Progress
                        value={t.progress}
                        className="h-2 flex-1 bg-white/10 [&>div]:bg-gradient-to-l [&>div]:from-cyan-500 [&>div]:to-violet-500"
                      />
                      <span className="text-[11px] font-bold text-cyan-300">{t.progress}%</span>
                    </div>
                  )}

                  {t.status === "failed" && t.errorMessage && (
                    <p className="mt-1.5 rounded-md bg-red-500/10 p-2 text-[11px] leading-relaxed text-red-300">
                      {t.errorMessage}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {t.resultUrls.map(
                        (u) =>
                          !u.startsWith("data:") && (
                            <a
                              key={u}
                              href={u}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-md bg-cyan-500/15 px-2 py-1 text-[11px] font-bold text-cyan-300 ring-1 ring-cyan-500/40 hover:bg-cyan-500/25"
                            >
                              فتح النتيجة ↗
                            </a>
                          )
                      )}
                    </div>
                    <span className="text-[10px] text-slate-500">محاولات: {t.attempts}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="text-left">
          <Button
            size="sm"
            variant="outline"
            onClick={load}
            className="h-8 border-white/15 text-xs text-slate-300 hover:bg-white/10"
          >
            ⟳ تحديث الآن
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
