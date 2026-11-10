// طبقة قاعدة البيانات Turso (libSQL) — عميل واحد عبر HTTP، متوافق مع بيئات Serverless
// يُنشئ المخطط تلقائيًا عند أول وصول (CREATE TABLE IF NOT EXISTS) دون حاجة لأداة ترحيل
import { createClient, type Client, type InValue } from "@libsql/client";

let client: Client | null = null;
let schemaPromise: Promise<void> | null = null;

/** عميل Turso المفرد — يُنشأ مرة واحدة لكل عملية (instance) */
export function getTurso(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error("TURSO_DATABASE_URL مفقود في متغيرات البيئة");
    client = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    });
  }
  return client;
}

/** إنشاء المخطط مرة واحدة فقط لكل عملية */
export async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getTurso();
      await db.execute(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`);
      await db.execute(`CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`);
      // فهارس للترتيب الصارم لل مفاتيح حسب أوقات الإضافة
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_keys_order ON api_keys (provider, created_at, id)"
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC)"
      );
    })().catch((err) => {
      // إعادة السماح بالمحاولة لاحقًا إذا فشل الإنشاء
      schemaPromise = null;
      throw err;
    });
  }
  return schemaPromise;
}

/** تنفيذ أي عملية قاعدة بيانات بعد ضمان وجود المخطط */
export async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  await ensureSchema();
  return fn(getTurso());
}

/** فحص صحة الاتصال بقاعدة البيانات (SELECT 1) */
export async function dbHealthy(): Promise<boolean> {
  try {
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ————— أنواع الصفوف —————

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: string; // image | video | merge
  prompt: string;
  params_json: string;
  status: string; // pending | processing | completed | failed
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
}

export interface KeyRow {
  id: string;
  provider: string; // kie | cometapi
  label: string;
  api_key: string;
  status: string; // active | exhausted | disabled
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string | null;
}

/** محاولة واحدة ضمن سجل محاولات المهمة */
export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

const TASK_COLS =
  "id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, error_message, attempts_json, created_at, updated_at, completed_at";

function rowToTask(r: Record<string, unknown>): TaskRow {
  return r as unknown as TaskRow;
}

function rowToKey(r: Record<string, unknown>): KeyRow {
  return r as unknown as KeyRow;
}

// ————— عمليات المهام —————

export async function insertTask(t: {
  id: string;
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: string;
  prompt?: string;
  params_json?: string;
  status: string;
  progress?: number;
}): Promise<void> {
  await withDb((db) =>
    db.execute({
      sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        t.id,
        t.provider ?? null,
        t.provider_task_id ?? null,
        t.key_id ?? null,
        t.model,
        t.type,
        t.prompt ?? "",
        t.params_json ?? "{}",
        t.status,
        t.progress ?? 0,
      ],
    })
  );
}

export async function getTask(id: string): Promise<TaskRow | null> {
  return withDb(async (db) => {
    const res = await db.execute({
      sql: `SELECT ${TASK_COLS} FROM tasks WHERE id = ?`,
      args: [id],
    });
    if (res.rows.length === 0) return null;
    return rowToTask(res.rows[0] as unknown as Record<string, unknown>);
  });
}

/** تحديث جزئي للمهمة + إضافة محاولة إلى السجل + ضبط completed_at تلقائيًا */
export async function updateTask(
  id: string,
  patch: Partial<TaskRow> & { attempt?: AttemptEntry } = {}
): Promise<TaskRow | null> {
  return withDb(async (db) => {
    const sets: string[] = [];
    const args: InValue[] = [];

    const { attempt, ...rest } = patch;
    const row = await db.execute({
      sql: `SELECT attempts_json, status, completed_at FROM tasks WHERE id = ?`,
      args: [id],
    });
    if (row.rows.length === 0) return null;
    const current = row.rows[0];

    // سجل المحاولات: إلحاق المحاولة الجديدة بالسجل الحالي
    if (attempt) {
      let attempts: AttemptEntry[] = [];
      try {
        attempts = JSON.parse(String(current.attempts_json ?? "[]"));
      } catch {
        attempts = [];
      }
      attempts.push(attempt);
      sets.push("attempts_json = ?");
      args.push(JSON.stringify(attempts));
    }

    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push((v === null ? null : v) as InValue);
    }

    sets.push("updated_at = datetime('now')");
    // عند الاكتمال: ضبط completed_at تلقائيًا
    const newStatus = rest.status;
    const alreadyCompleted = String(current.completed_at ?? "") !== "";
    if ((newStatus === "completed" || newStatus === "failed") && !alreadyCompleted) {
      sets.push("completed_at = datetime('now')");
    }

    args.push(id);
    await db.execute({
      sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
    return getTaskCached(db, id);
  });
}

async function getTaskCached(db: Client, id: string): Promise<TaskRow | null> {
  const res = await db.execute({
    sql: `SELECT ${TASK_COLS} FROM tasks WHERE id = ?`,
    args: [id],
  });
  if (res.rows.length === 0) return null;
  return rowToTask(res.rows[0] as unknown as Record<string, unknown>);
}

export async function listRecentTasks(
  limit = 10,
  filters: { type?: string; status?: string } = {}
): Promise<TaskRow[]> {
  return withDb(async (db) => {
    const args: InValue[] = [];
    const where: string[] = [];
    if (filters.type) {
      where.push("type = ?");
      args.push(filters.type);
    }
    if (filters.status) {
      where.push("status = ?");
      args.push(filters.status);
    }
    args.push(Math.min(Math.max(limit, 1), 50));
    const res = await db.execute({
      sql: `SELECT ${TASK_COLS} FROM tasks ${
        where.length ? "WHERE " + where.join(" AND ") : ""
      } ORDER BY created_at DESC, id DESC LIMIT ?`,
      args,
    });
    return res.rows.map(
      (r) => rowToTask(r as unknown as Record<string, unknown>)
    );
  });
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  return withDb(async (db) => {
    const res = await db.execute(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'processing' OR status = 'pending' THEN 1 ELSE 0 END) AS processing
       FROM tasks`
    );
    const r = res.rows[0] as unknown as Record<string, number | null>;
    return {
      total: Number(r.total ?? 0),
      completed: Number(r.completed ?? 0),
      failed: Number(r.failed ?? 0),
      processing: Number(r.processing ?? 0),
    };
  });
}

/** حذف المهام (يُستخدم لتنظيف مهام الاختبار) */
export async function deleteTask(id: string): Promise<boolean> {
  return withDb(async (db) => {
    const res = await db.execute({
      sql: "DELETE FROM tasks WHERE id = ?",
      args: [id],
    });
    return res.rowsAffected > 0;
  });
}

// ————— عمليات المفاتيح —————

export async function insertKey(k: {
  id: string;
  provider: string;
  label?: string;
  api_key: string;
  status?: string;
}): Promise<void> {
  await withDb((db) =>
    db.execute({
      sql: `INSERT INTO api_keys (id, provider, label, api_key, status) VALUES (?, ?, ?, ?, ?)`,
      args: [k.id, k.provider, k.label ?? "", k.api_key, k.status ?? "active"],
    })
  );
}

export async function getKey(id: string): Promise<KeyRow | null> {
  return withDb(async (db) => {
    const res = await db.execute({
      sql: "SELECT * FROM api_keys WHERE id = ?",
      args: [id],
    });
    if (res.rows.length === 0) return null;
    return rowToKey(res.rows[0] as unknown as Record<string, unknown>);
  });
}

/** تجمع كل المفاتيح غير المعطلة للمزودين المطلوبين بالترتيب الصارم لأوقات الإضافة.
 * ملاحظة مهمة: المفاتيح المستنفدة (exhausted) تبقى في القائمة عمدًا — الاستثناء الوحيد هو التعطيل اليدوي (disabled). */
export async function getKeyPool(
  providers: string[]
): Promise<KeyRow[]> {
  return withDb(async (db) => {
    const placeholders = providers.map(() => "?").join(", ");
    const res = await db.execute({
      sql: `SELECT * FROM api_keys
            WHERE status != 'disabled' AND provider IN (${placeholders})
            ORDER BY created_at ASC, id ASC`,
      args: providers,
    });
    return res.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
  });
}

export async function listKeys(): Promise<KeyRow[]> {
  return withDb(async (db) => {
    const res = await db.execute(
      "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC"
    );
    return res.rows.map((r) => rowToKey(r as unknown as Record<string, unknown>));
  });
}

export async function keyExists(provider: string, apiKey: string): Promise<boolean> {
  return withDb(async (db) => {
    const res = await db.execute({
      sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
      args: [provider, apiKey],
    });
    return res.rows.length > 0;
  });
}

export async function patchKey(
  id: string,
  patch: Partial<Pick<KeyRow, "status" | "label">>
): Promise<KeyRow | null> {
  await withDb(async (db) => {
    const sets: string[] = [];
    const args: InValue[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      sets.push(`${k} = ?`);
      args.push(v as InValue);
    }
    if (!sets.length) return;
    args.push(id);
    await db.execute({
      sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
  });
  return getKey(id);
}

export async function deleteKey(id: string): Promise<boolean> {
  return withDb(async (db) => {
    const res = await db.execute({
      sql: "DELETE FROM api_keys WHERE id = ?",
      args: [id],
    });
    return res.rowsAffected > 0;
  });
}

/** تحديث عدّادات المفتاح بعد كل استخدام (نجاح أو فشل + فئة الخطأ) */
export async function recordKeyUsage(
  keyId: string,
  ok: boolean,
  opts: { errorClass?: string; error?: string; newStatus?: string } = {}
): Promise<void> {
  await withDb(async (db) => {
    const sets = [
      "usage_count = usage_count + 1",
      ok ? "success_count = success_count + 1" : "fail_count = fail_count + 1",
      "last_used_at = datetime('now')",
      "last_checked_at = datetime('now')",
    ];
    const args: InValue[] = [];
    if (!ok) {
      sets.push("last_error = ?");
      args.push(opts.error ? opts.error.slice(0, 500) : "خطأ غير معروف");
      if (opts.newStatus) {
        sets.push("status = ?");
        args.push(opts.newStatus);
      }
    } else {
      sets.push("last_error = NULL");
    }
    args.push(keyId);
    await db.execute({
      sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`,
      args,
    });
  });
}
