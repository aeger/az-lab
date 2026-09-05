/**
 * az-lab task-queue Worker — validating ingest + queue consumer.
 *
 * Flow:  producer --POST /enqueue--> [validate] --> Cloudflare Queue
 *                                                     |
 *                        consumer <--(batch)----------+
 *                        [strict validate] --> Supabase REST insert
 *                        on failure: retry (x3) --> DLQ --> Discord alert
 *
 * Why: the legacy producers POSTed straight to Supabase with
 * `curl -sf .../task_queue &>/dev/null &`, which swallowed NOT NULL rejections
 * so completely that a null-description bug churned the DB log invisibly.
 * This Worker enforces title+description at the boundary and makes every
 * failure visible (Observability logs + DLQ + Discord), never silently dropped.
 */

export interface Env {
  TASK_QUEUE: Queue<TaskMessage>;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  INGEST_SECRET: string;
  DISCORD_WEBHOOK?: string;
}

interface TaskMessage {
  title: string;
  description: string;
  target: string;
  source: string;
  priority: number;
  status: string;
  context?: unknown;
  tags?: string[];
  goal_id?: string;
}

type ValidateResult =
  | { ok: true; task: TaskMessage }
  | { ok: false; error: string };

// Mirror the task_queue CHECK constraints so no invalid enum value can reach
// Postgres (it would 23514 and bounce to the DLQ). Keep in sync with the DB.
const ALLOWED_SOURCES = new Set([
  "cowork", "chat", "claude-code", "system", "desktop", "wren-scheduler", "dashboard",
]);
const ALLOWED_TARGETS = new Set([
  "claude-code", "cowork", "chat", "desktop", "any", "iris", "wren", "atlas", "jeff",
]);

/** Coerce an arbitrary payload into a valid task, or explain why it can't be. */
function validateTask(raw: unknown): ValidateResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "body must be a JSON object" };
  }
  const t = raw as Record<string, unknown>;
  const title = String(t.title ?? "").trim();
  let description = String(t.description ?? "").trim();

  if (!title && !description) {
    return { ok: false, error: "title and description are both empty" };
  }
  // task_queue.description is NOT NULL — enforce it here so it can never reach
  // the DB null. Fall back to the title if a producer omitted a description.
  if (!description) description = title;

  const priorityRaw = Number(t.priority);
  const priority = [1, 2, 3].includes(priorityRaw) ? priorityRaw : 2;

  // Coerce source/target to a constraint-valid value rather than let an unknown
  // one 23514 at the DB. Unknown source -> "system"; unknown target -> "claude-code".
  const srcRaw = String(t.source ?? "system");
  const tgtRaw = String(t.target ?? "claude-code");

  const task: TaskMessage = {
    title: title || description.slice(0, 60),
    description,
    target: ALLOWED_TARGETS.has(tgtRaw) ? tgtRaw : "claude-code",
    source: ALLOWED_SOURCES.has(srcRaw) ? srcRaw : "system",
    priority,
    status: "pending",
  };
  if (t.context !== undefined) task.context = t.context;
  if (Array.isArray(t.tags)) task.tags = t.tags as string[];
  if (t.goal_id) task.goal_id = String(t.goal_id);

  return { ok: true, task };
}

async function insertToSupabase(task: TaskMessage, env: Env): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/task_queue`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(task),
  });
  if (!res.ok) {
    throw new Error(`supabase insert ${res.status}: ${await res.text()}`);
  }
}

async function alertDiscord(env: Env, content: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK) return;
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch(() => {}); // alerting must never throw into the consumer
}

export default {
  // ---- Ingest: producers POST here instead of writing to Supabase directly ----
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "az-task-queue-worker" });
    }
    if (req.method !== "POST" || url.pathname !== "/enqueue") {
      return new Response("POST /enqueue", { status: 404 });
    }
    if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) {
      return new Response("unauthorized", { status: 401 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const v = validateTask(body);
    if (!v.ok) {
      return Response.json({ error: v.error }, { status: 422 });
    }
    await env.TASK_QUEUE.send(v.task);
    return Response.json({ queued: true, title: v.task.title }, { status: 202 });
  },

  // ---- Consume: main queue writes to Supabase; DLQ surfaces failures ----
  async queue(batch: MessageBatch<TaskMessage>, env: Env): Promise<void> {
    const isDlq = batch.queue.endsWith("-dlq");

    for (const msg of batch.messages) {
      if (isDlq) {
        const t = msg.body;
        console.error("DLQ task failed after retries", JSON.stringify(t));
        await alertDiscord(
          env,
          `⚠️ task_queue DLQ — "${t?.title ?? "?"}" (source=${t?.source ?? "?"}) failed to insert after retries`,
        );
        msg.ack(); // acked: it's now surfaced, don't loop the DLQ
        continue;
      }

      const v = validateTask(msg.body);
      if (!v.ok) {
        // Structurally invalid even after ingest validation — log and drop
        // rather than retry forever. Visible in Observability.
        console.error("dropping invalid task", v.error, JSON.stringify(msg.body));
        msg.ack();
        continue;
      }
      try {
        await insertToSupabase(v.task, env);
        msg.ack();
      } catch (err) {
        console.error("supabase insert failed, retrying", String(err));
        msg.retry(); // exhausted retries route to the DLQ automatically
      }
    }
  },
} satisfies ExportedHandler<Env, TaskMessage>;
