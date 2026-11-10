'use client'

// لوحة الإدارة الرئيسية — صفحة واحدة بثلاث بطاقات + شارة حالة الاتصال بالخادم
import { useEffect, useState } from "react";
import KeyManager from "@/components/dashboard/KeyManager";
import TasksPanel from "@/components/dashboard/TasksPanel";
import ConnectionCard from "@/components/dashboard/ConnectionCard";

export interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);

  // تحديث حالة الصحة كل ~10 ثوانٍ
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as HealthInfo;
        if (alive) setHealth(data);
      } catch {
        if (alive) setHealth(null);
      }
    };
    load();
    const id = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const dbOk = health?.ok === true;
  const mergerOk = health?.merger?.healthy === true;

  return (
    <div
      className="min-h-screen flex flex-col bg-gradient-to-b from-[#070b16] via-[#0b1226] to-[#070b16] text-slate-100"
      dir="rtl"
    >
      {/* الترويسة — حالة /api/health */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#070b16]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-cyan-500 to-violet-600 text-xl shadow-lg shadow-violet-900/40">
              🎬
            </div>
            <div>
              <h1 className="text-lg font-extrabold leading-tight sm:text-xl">
                لوحة إدارة مولد الوسائط MCP
              </h1>
              <p className="text-xs text-slate-400">
                توليد الصور والفيديو + دمج المقاطع — تبديل تسلسلي تلقائي بين المفاتيح
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* شارة قاعدة البيانات */}
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ring-1 ${
                dbOk
                  ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/40"
                  : "bg-red-500/10 text-red-300 ring-red-500/40"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${dbOk ? "animate-pulse bg-emerald-400" : "bg-red-400"}`}
              />
              {dbOk ? "Turso متصل" : "غير متصل"}
            </span>
            {/* شارة خدمة الدمج */}
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-bold ring-1 ${
                mergerOk
                  ? "bg-cyan-500/10 text-cyan-300 ring-cyan-500/40"
                  : "bg-amber-500/10 text-amber-300 ring-amber-500/40"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${mergerOk ? "bg-cyan-400" : "bg-amber-400"}`} />
              خدمة الدمج {mergerOk ? "متاحة" : "غير متاحة"}
            </span>
            {health?.authRequired && (
              <span className="rounded-full bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-300 ring-1 ring-violet-500/40">
                محمي برمز Bearer
              </span>
            )}
          </div>
        </div>
      </header>

      {/* البطاقات الثلاث */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <div className="grid gap-6 lg:grid-cols-2">
          <KeyManager />
          <TasksPanel />
          <div className="lg:col-span-2">
            <ConnectionCard health={health} />
          </div>
        </div>
      </main>

      {/* تذييل لاصق بأسفل الشاشة */}
      <footer className="mt-auto border-t border-white/10 py-4 text-center text-xs text-slate-500">
        مولد الوسائط MCP — روابط فقط، لا تُرفع ملفات على الخادم · المفاتيح مخفية دائمًا في كل الردود
      </footer>
    </div>
  );
}
