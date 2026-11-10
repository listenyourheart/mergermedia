'use client'

// بطاقة إدارة المفاتيح — إضافة/تعطيل/تفعيل/حذف مع إخفاء إلزامي للمفاتيح وشارات حالة ملونة
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface ApiKey {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string | null;
}

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  active: { label: "نشط", className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40" },
  exhausted: { label: "مستنفد", className: "bg-amber-500/15 text-amber-300 ring-amber-500/40" },
  disabled: { label: "معطل", className: "bg-slate-500/15 text-slate-400 ring-slate-500/40" },
};

export default function KeyManager() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = (await res.json()) as { ok: boolean; keys: ApiKey[] };
      if (data.ok) setKeys(data.keys);
    } catch {
      // تجاهل أخطاء التحديث الخلفي
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const addKey = async () => {
    if (!apiKey.trim()) {
      setNotice({ ok: false, text: "أدخل المفتاح أولاً" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) {
        setNotice({ ok: true, text: "تمت إضافة المفتاح بنجاح" });
        setApiKey("");
        setLabel("");
        await load();
      } else {
        setNotice({ ok: false, text: data.error ?? "فشل الحفظ" });
      }
    } catch {
      setNotice({ ok: false, text: "تعذر الاتصال بالخادم" });
    } finally {
      setBusy(false);
    }
  };

  const toggleKey = async (k: ApiKey) => {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    await load();
  };

  const deleteKey = async (k: ApiKey) => {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    await load();
  };

  return (
    <Card className="border-white/10 bg-white/[0.03] backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-extrabold">
          🔑 إدارة المفاتيح
        </CardTitle>
        <CardDescription className="rounded-lg bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200 ring-1 ring-amber-500/30">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (المفتاح الأول ثم التالي...) مع تبديل تلقائي
          فوري عند الخطأ أو استنفاد الرصيد دون توقف. المفتاح المستنفد يبقى في القاعدة ولا يُحذف —
          الاستثناء الوحيد هو التعطيل اليدوي.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* نموذج الإضافة */}
        <div className="grid gap-2 sm:grid-cols-[130px_1fr]">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="h-10 rounded-md border border-white/15 bg-[#0d1428] px-3 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-cyan-500/50"
            aria-label="المزود"
          >
            <option value="kie">kie.ai</option>
            <option value="cometapi">CometAPI</option>
          </select>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="تسمية اختيارية (مثال: الحساب الرئيسي)"
            className="border-white/15 bg-[#0d1428] text-slate-100 placeholder:text-slate-500"
          />
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="الصق مفتاح API هنا"
            type="password"
            autoComplete="off"
            dir="ltr"
            className="border-white/15 bg-[#0d1428] font-mono text-sm text-slate-100 placeholder:text-slate-500 sm:col-span-2"
          />
          <Button
            onClick={addKey}
            disabled={busy}
            className="bg-gradient-to-l from-cyan-600 to-violet-600 font-bold text-white hover:from-cyan-500 hover:to-violet-500 sm:col-span-2"
          >
            {busy ? "جارٍ الحفظ..." : "＋ إضافة المفتاح"}
          </Button>
        </div>

        {notice && (
          <p
            className={`rounded-lg p-2.5 text-xs font-semibold ${
              notice.ok
                ? "bg-emerald-500/10 text-emerald-300"
                : "bg-red-500/10 text-red-300"
            }`}
          >
            {notice.text}
          </p>
        )}

        {/* قائمة المفاتيح */}
        {keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-white/15 p-4 text-center text-xs text-slate-500">
            لا توجد مفاتيح بعد — أضف أول مفتاح لبدء التوليد
          </p>
        ) : (
          <ul className="custom-scrollbar max-h-96 space-y-3 overflow-y-auto pl-1">
            {keys.map((k, idx) => {
              const badge = STATUS_BADGE[k.status] ?? STATUS_BADGE.disabled;
              return (
                <li
                  key={k.id}
                  className="rounded-xl border border-white/10 bg-[#0d1428] p-3 transition hover:border-cyan-500/40"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="grid h-6 w-6 place-items-center rounded-md bg-cyan-500/15 text-[11px] font-bold text-cyan-300">
                        {idx + 1}
                      </span>
                      <span className="text-[11px] font-bold text-slate-400">
                        {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                      </span>
                      <Badge className={`border-0 text-[11px] font-bold ring-1 ${badge.className}`}>
                        {badge.label}
                      </Badge>
                      {k.label && (
                        <span className="text-xs text-slate-300">· {k.label}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => toggleKey(k)}
                        className="h-8 border-white/15 px-2.5 text-xs text-slate-200 hover:bg-white/10"
                      >
                        {k.status === "disabled" ? "تفعيل" : "تعطيل"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => deleteKey(k)}
                        className="h-8 border-red-500/40 px-2.5 text-xs text-red-300 hover:bg-red-500/15"
                      >
                        حذف
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
                    <span dir="ltr" className="font-mono text-slate-300">
                      {k.maskedKey}
                    </span>
                    <span>استخدام: {k.usageCount}</span>
                    <span className="text-emerald-400">نجاح: {k.successCount}</span>
                    <span className="text-red-400">فشل: {k.failCount}</span>
                  </div>
                  {k.lastError && (
                    <p className="mt-1.5 truncate text-[11px] text-amber-300/80" title={k.lastError}>
                      آخر خطأ: {k.lastError}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
