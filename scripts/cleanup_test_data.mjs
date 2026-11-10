// تنظيف آثار الاختبار: حذف مهام الاختبار من tasks + المفتاح الوهمي من api_keys
// + حذف مهام الدمج من جداول merger_* — مع إبقاء المفتاح الحقيقي للمستخدم
import { createClient } from "@libsql/client";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
const db = createClient({ url, authToken: token });

async function main() {
  // 1) حذف المفتاح الوهمي (أثر اختبار) — المفتاح الحقيقي يبقى
  const fake = await db.execute({
    sql: "SELECT id, label FROM api_keys WHERE api_key LIKE 'FAKE-KEY%'",
  });
  for (const r of fake.rows) {
    await db.execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [r.id] });
    console.log("مفتاح وهمي محذوف:", r.label);
  }

  // 2) حذف مهام الاختبار من tasks (كل المهام الحالية كانت اختبارات)
  const tasks = await db.execute("SELECT id, type, status FROM tasks");
  for (const r of tasks.rows) {
    await db.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [r.id] });
    console.log("مهمة محذوفة:", r.type, r.status, String(r.id).slice(0, 8));
  }

  // 3) حذف مهام الدمج من جداول الخدمة merger_*
  const jobs = await db.execute("SELECT id FROM merger_jobs");
  for (const r of jobs.rows) {
    await db.execute({ sql: "DELETE FROM merger_jobs WHERE id = ?", args: [r.id] });
    await db.execute({ sql: "DELETE FROM merger_chunks WHERE job_id = ?", args: [r.id] });
    await db.execute({ sql: "DELETE FROM merger_output WHERE job_id = ?", args: [r.id] });
    console.log("مهمة دمج محذوفة:", r.id);
  }

  // 4) تحقق نهائي
  const t = await db.execute("SELECT COUNT(*) AS c FROM tasks");
  const k = await db.execute("SELECT COUNT(*) AS c FROM api_keys");
  const j = await db.execute("SELECT COUNT(*) AS c FROM merger_jobs");
  console.log(
    `الحالة النهائية: tasks=${t.rows[0].c} | api_keys=${k.rows[0].c} | merger_jobs=${j.rows[0].c}`
  );
}

main().catch((e) => {
  console.error("فشل التنظيف:", e.message);
  process.exit(1);
});
