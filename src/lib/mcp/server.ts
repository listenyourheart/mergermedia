// خادم MCP — 5 أدوات، الوصف بالإنجليزية (يقرأها العميل) ونتائج الاستدعاء بالعربية
// يعمل بوضع عديم الحالة (stateless) متوافق مع Serverless: خادم ونقل جديدان لكل طلب
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "./info";
import { runGeneration, refreshGenerationTask, formatTaskMessage, parseUrls, ParamsReject } from "@/lib/orchestrator";
import { runMerge, refreshMergeTask, MergeReject } from "@/lib/merger";
import { listRecentTasks, getTask, taskStats } from "@/lib/turso";
import type { TaskRow } from "@/lib/turso";
import type {
  RequestHandlerExtra,
} from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";

/** إنشاء مثيل الخادم مع التعليمات الجاهزة للإرسال مع initialize */
export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // —— أدوات مساعدة داخلية ——

  /** إشعار تقدم كل ~3 ثوانٍ إذا وفر العميل _meta.progressToken */
  function makeProgressReporter(
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    total = 100
  ): ((progress: number, message: string) => Promise<void>) | undefined {
    const token = extra._meta?.progressToken;
    if (token === undefined || token === null) return undefined;
    return async (progress: number, message: string) => {
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress, total, message },
        } as ServerNotification);
      } catch {
        // إشعارات التقدم ليست حرجة — تجاهل أي فشل
      }
    };
  }

  function toolResult(text: string, isError = false) {
    return { content: [{ type: "text" as const, text }], isError };
  }

  function mergeText(t: TaskRow): string {
    return formatTaskMessage(t);
  }

  // ————— 1) generate_image —————
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active keys). " +
        "Returns the image link directly if it completes during the wait window, otherwise returns a task_id — " +
        "call get_task every ~10 seconds until completed, then show the link and stop.",
      inputSchema: {
        prompt: z
          .string()
          .min(1, "❌ الوصف (prompt) مطلوب لإنشاء الصورة")
          .describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z
          .enum(["auto", "transparent", "opaque"])
          .default("auto")
          .describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const onProgress = makeProgressReporter(extra);
      try {
        const { noKeys, task } = await runGeneration({
          type: "image",
          modelName: args.model,
          prompt: args.prompt,
          params: {
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            background: args.background,
            output_format: args.output_format,
          },
          waitSeconds: args.wait_seconds,
          onProgress,
        });
        if (noKeys) {
          return toolResult(
            `❌ لا توجد مفاتيح نشطة لخدمة ${args.model}. أضف مفتاحًا واحدًا على الأقل من لوحة الإدارة ثم أعد المحاولة.`,
            true
          );
        }
        return toolResult(formatTaskMessage(task as TaskRow), task?.status === "failed");
      } catch (e) {
        if (e instanceof ParamsReject) return toolResult(e.message, true);
        return toolResult("❌ حدث خطأ غير متوقع أثناء إنشاء الصورة. حاول مرة أخرى.", true);
      }
    }
  );

  // ————— 2) generate_video —————
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue/effects/music, optional image-to-video). " +
        "Video takes minutes: short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z
          .string()
          .max(4096, "❌ الوصف يتجاوز الحد الأقصى 4096 حرفًا")
          .describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z
          .string()
          .optional()
          .describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z
          .number()
          .int()
          .min(1)
          .max(15)
          .default(8)
          .describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const onProgress = makeProgressReporter(extra);
      try {
        const { noKeys, task } = await runGeneration({
          type: "video",
          modelName: args.model,
          prompt: args.prompt,
          params: {
            image_url: args.image_url,
            aspect_ratio: args.aspect_ratio,
            resolution: args.resolution,
            enable_audio: args.enable_audio, // الافتراضي صوت مفعل — kie يولّد الصوت دائمًا
            duration: args.duration,
          },
          waitSeconds: args.wait_seconds,
          onProgress,
        });
        if (noKeys) {
          return toolResult(
            `❌ لا توجد مفاتيح نشطة لخدمة ${args.model}. أضف مفتاحًا واحدًا على الأقل من لوحة الإدارة ثم أعد المحاولة.`,
            true
          );
        }
        return toolResult(formatTaskMessage(task as TaskRow), task?.status === "failed");
      } catch (e) {
        if (e instanceof ParamsReject) return toolResult(e.message, true);
        return toolResult("❌ حدث خطأ غير متوقع أثناء إنشاء الفيديو. حاول مرة أخرى.", true);
      }
    }
  );

  // ————— 3) merge_videos —————
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video links — such as links from generate_video) " +
        "or 'task_ids' (completed video tasks whose result links are resolved from the database in order — ideal after generating several clips). " +
        "Merging is usually quick: short wait with progress streaming, then a task_id for the merge — track it with get_task. " +
        "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, "❌ الدمج يتطلب مقطعين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ الحد الأقصى لمقاطع الدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Public direct video URLs (http/https) in merge order — the first clip starts the final video."
          ),
        task_ids: z
          .array(z.string())
          .min(2, "❌ الدمج يتطلب مقطعين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ الحد الأقصى لمقاطع الدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe(
            "Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."
          ),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const onProgress = makeProgressReporter(extra);
      try {
        const { task } = await runMerge({
          urls: args.urls,
          taskIds: args.task_ids,
          waitSeconds: args.wait_seconds,
          onProgress,
        });
        return toolResult(mergeText(task as TaskRow), task?.status === "failed");
      } catch (e) {
        if (e instanceof MergeReject) return toolResult(e.message, true);
        return toolResult("❌ حدث خطأ غير متوقع أثناء الدمج. حاول مرة أخرى.", true);
      }
    }
  );

  // ————— 4) get_task —————
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes from the provider/service if still processing). " +
        "Poll it every ~10 seconds; when completed you will find the result links — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1, "❌ معرف المهمة (task_id) مطلوب"),
      },
    },
    async (args) => {
      const task = await getTask(args.task_id);
      if (!task) {
        return toolResult(`❌ لا توجد مهمة بهذا المعرف: ${args.task_id}. تحقق من task_id أو استخدم list_media لعرض المهام الأخيرة.`, true);
      }
      // تحديث مباشر من المزود/خدمة الدمج إن كانت قيد المعالجة (نفس منطق المحاولة والتبديل)
      let current: TaskRow | null = task;
      if (task.status === "processing" || task.status === "pending") {
        try {
          if (task.provider === "merger") {
            current = await refreshMergeTask(task);
          } else {
            current = await refreshGenerationTask(task);
          }
        } catch {
          current = task;
        }
      }
      return toolResult(formatTaskMessage(current), current?.status === "failed");
    }
  );

  // ————— 5) list_media —————
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "The latest images/videos/merges stored with their links from the database (no regeneration) — to recall earlier results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const tasks = await listRecentTasks(args.limit ?? 10, {
        type: args.type,
        status: args.status,
      });
      if (!tasks.length) {
        return toolResult("📭 لا توجد مهام مخزنة بعد. أنشئ وسائط أولًا عبر generate_image أو generate_video.");
      }
      const lines: string[] = ["📋 آخر الوسائط المخزنة (من الأحدث إلى الأقدم):", ""];
      for (const t of tasks) {
        const statusEmoji =
          t.status === "completed" ? "✅" : t.status === "failed" ? "❌" : "⏳";
        const typeLabel =
          t.type === "image" ? "صورة" : t.type === "video" ? "فيديو" : t.type === "merge" ? "دمج" : t.type;
        lines.push(`${statusEmoji} ${typeLabel} | ${t.model} | ${t.status}${t.progress ? ` (${t.progress}%)` : ""}`);
        lines.push(`   task_id: ${t.id}`);
        lines.push(`   created: ${t.created_at ?? "-"}`);
        const urls = parseUrls(t.result_urls_json);
        for (const u of urls) lines.push(`   الرابط: ${u}`);
        if (t.status === "failed" && t.error_message) lines.push(`   السبب: ${t.error_message}`);
        lines.push("");
      }
      const stats = await taskStats();
      lines.push(
        `📊 الإجمالي: ${stats.total} | مكتملة: ${stats.completed} | فاشلة: ${stats.failed} | قيد المعالجة: ${stats.processing}`
      );
      return toolResult(lines.join("\n"));
    }
  );

  return server;
}

/** قائمة الأدوات المعروفة — تُستخدم لرسالة الأداة غير المعروفة بالعربية في المسار */
export const KNOWN_TOOLS = [
  "generate_image",
  "generate_video",
  "merge_videos",
  "get_task",
  "list_media",
] as const;
