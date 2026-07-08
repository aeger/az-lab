/**
 * az-lab lab-health-worker — pull-based health monitor.
 *
 * Cron (every 5 min) calls the Supabase RPC `lab_health_snapshot()` and alerts
 * Discord when the health state CHANGES (KV stores the last signature so a
 * standing issue isn't re-posted every run; recovery posts an all-clear).
 *
 * Signals: stale/breaker-tripped agents, failed/escalated tasks (1h),
 * tasks stuck >2h, and overdue schedulers. Log Drains are Team-plan only, so
 * this polls for signals rather than ingesting logs.
 */

export interface Env {
  HEALTH_KV: KVNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  DISCORD_WEBHOOK?: string;
  CHECK_SECRET?: string;
}

interface Snapshot {
  ts: string;
  stuck_tasks: number;
  failed_tasks: { id: string; title: string; status: string }[];
  stale_agents: { agent: string; last: string; breaker: boolean }[];
  overdue_schedules: { name: string; due: string; last: string | null }[];
}

async function snapshot(env: Env): Promise<Snapshot> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/lab_health_snapshot`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`snapshot ${res.status}: ${await res.text()}`);
  return (await res.json()) as Snapshot;
}

function assess(s: Snapshot): { healthy: boolean; sig: string; lines: string[] } {
  const lines: string[] = [];
  if (s.stale_agents?.length)
    lines.push(`🔴 stale agents: ${s.stale_agents.map((a) => a.agent + (a.breaker ? " (breaker)" : "")).join(", ")}`);
  if (s.failed_tasks?.length)
    lines.push(`🔴 failed/escalated tasks (1h): ${s.failed_tasks.map((t) => `${t.title} [${t.status}]`).join("; ")}`);
  if (s.stuck_tasks > 0)
    lines.push(`🟠 ${s.stuck_tasks} task(s) stuck >2h in pending/claimed`);
  if (s.overdue_schedules?.length)
    lines.push(`🟠 overdue schedulers: ${s.overdue_schedules.map((x) => x.name).join(", ")}`);
  const healthy = lines.length === 0;
  return { healthy, sig: healthy ? "healthy" : lines.join(" | "), lines };
}

async function post(env: Env, content: string): Promise<void> {
  if (!env.DISCORD_WEBHOOK) return;
  await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch(() => {});
}

async function run(env: Env): Promise<{ state: string; changed: boolean }> {
  const s = await snapshot(env);
  const { healthy, sig, lines } = assess(s);
  const prev = await env.HEALTH_KV.get("last_sig");
  const changed = prev !== sig;
  if (changed) {
    if (!healthy) await post(env, `⚠️ **az-lab health** — issue detected:\n${lines.join("\n")}`);
    else if (prev && prev !== "healthy") await post(env, `✅ **az-lab health** — recovered, all clear.`);
    await env.HEALTH_KV.put("last_sig", sig);
  }
  return { state: healthy ? "healthy" : "unhealthy", changed };
}

export default {
  // GET /check (secret-guarded) — on-demand snapshot for debugging.
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname !== "/check") return new Response("lab-health-worker: GET /check", { status: 404 });
    if (env.CHECK_SECRET && req.headers.get("x-check-secret") !== env.CHECK_SECRET)
      return new Response("unauthorized", { status: 401 });
    try {
      const s = await snapshot(env);
      const a = assess(s);
      return Response.json({ healthy: a.healthy, issues: a.lines, snapshot: s });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  },

  async scheduled(_c: ScheduledController, env: Env): Promise<void> {
    try {
      console.log("health run", JSON.stringify(await run(env)));
    } catch (e) {
      console.error("health run failed", String(e));
      await post(env, `❌ lab-health-worker error: ${String(e)}`);
    }
  },
} satisfies ExportedHandler<Env>;
