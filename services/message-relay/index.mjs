#!/usr/bin/env node
// message-relay — Wren's realtime listener for the agent Relay pathway.
//
// Subscribes to Supabase Realtime (raw Phoenix v1.0.0 WebSocket — supabase-js
// hardcodes vsn=2.0.0 which this project's Realtime server rejects; client
// pattern copied from memory-mcp-server startMemorySyncListener) for INSERTs on:
//   • agent_messages — messages addressed to wren (or broadcast) spawn a
//     headless `claude -p` session whose final output is posted back as the
//     reply row. kind='task' rows are escalated into task_queue instead.
//   • task_queue — debounced `systemctl --user start claude-queue-poll.service`,
//     replacing the zombie realtime_listener.py (broken Python realtime lib).
//
// Concurrency: one claude spawn at a time (FIFO). Missed-while-down messages
// are drained by a catch-up SELECT on every (re)connect. Kill switch honored
// via public.check_kill_switch('wren') before every spawn.

import { WebSocket } from "ws";
import { spawn, execFile } from "node:child_process";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
if (!SUPABASE_URL || !ANON_KEY || !SECRET_KEY) {
  console.error("[relay] SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY required");
  process.exit(1);
}

const AGENT = "wren";
// Max auto-reply depth per thread. Beyond this the relay stops replying rather
// than letting two agents converse forever (see the 2026-08-29 ping-pong).
const MAX_HOPS = Number(process.env.RELAY_MAX_HOPS || 3);
const AUTH_FAIL_RE = /Failed to authenticate|OAuth session expired|API Error|Invalid API key|401/i;
const MY_NAMES = new Set(["wren", "claude-code"]);
const CLAUDE_BIN = process.env.RELAY_CLAUDE_BIN || "claude";
const CLAUDE_TIMEOUT_MS = Number(process.env.RELAY_CLAUDE_TIMEOUT_MS || 300_000);
const QUEUE_DEBOUNCE_MS = 2_000;

const REST = `${SUPABASE_URL}/rest/v1`;
const HEADERS = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};

async function rest(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${REST}/${path}`, {
    method,
    headers: { ...HEADERS, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function killSwitchHalted() {
  try {
    const rows = await rest("POST", "rpc/check_kill_switch", { p_agent: AGENT });
    return Array.isArray(rows) && rows.some(r => r.halted);
  } catch (e) {
    console.warn(`[relay] kill-switch check failed (${e.message}) — proceeding cautiously`);
    return false;
  }
}

function logActivity(content, taskId = null, meta = {}) {
  rest("POST", "agent_activity", {
    agent: AGENT,
    activity_type: "status",
    content: content.slice(0, 500),
    ...(taskId ? { task_id: taskId } : {}),
    metadata: { via: "message-relay", ...meta },
  }).catch(e => console.warn(`[relay] logActivity failed: ${e.message}`));
}

// ── Message handling ─────────────────────────────────────────────────────────

const seen = new Set();          // message ids already handled this process
const workQueue = [];            // FIFO of pending message rows
let working = false;

// Per-thread count of replies THIS process has generated. The meta.hop cap
// trusts the peer to echo the counter back; this one does not depend on the
// peer at all, so an old or buggy listener on the other end cannot loop us.
const repliesByThread = new Map();
function threadKey(row) { return row.thread_id ?? row.id; }

function enqueueMessage(row) {
  if (!row || seen.has(row.id)) return;
  if (!MY_NAMES.has(row.to_agent ?? "") && row.to_agent !== null) return; // not for us
  if (MY_NAMES.has(row.from_agent)) return;                              // our own
  if (row.kind === "status" || row.kind === "system") return;            // informational

  // Loop breaker (2026-08-29). The self-name guard alone is NOT enough: A's
  // auto-reply lands on B, B spawns a session and auto-replies to A, forever.
  // A failing agent makes it worse — it errors in ~2s, so the loop runs at
  // machine speed and burns tokens. Two independent cuts:
  const meta = row.meta || {};
  //  1. An error report must never cause the other side to spawn anything.
  if (meta.auto_error) {
    console.warn(`[relay] not spawning for error report ${row.id} from ${row.from_agent}: ${String(row.body).slice(0, 120)}`);
    rest("PATCH", `agent_messages?id=eq.${row.id}`, { delivered_at: new Date().toISOString() }).catch(() => {});
    return;
  }
  //  2. Bounded conversation depth: a thread may auto-reply MAX_HOPS times.
  const hop = Number(meta.hop || 0);
  const mine = repliesByThread.get(threadKey(row)) || 0;
  if (hop >= MAX_HOPS || mine >= MAX_HOPS) {
    console.warn(`[relay] hop cap reached on ${row.id} (thread ${threadKey(row)}, peer hop ${hop}, my replies ${mine}) — not replying`);
    rest("PATCH", `agent_messages?id=eq.${row.id}`, { delivered_at: new Date().toISOString() }).catch(() => {});
    return;
  }
  row.__hop = Math.max(hop, mine);

  seen.add(row.id);
  if (seen.size > 5000) seen.clear();
  workQueue.push(row);
  pump();
}

async function pump() {
  if (working) return;
  const row = workQueue.shift();
  if (!row) return;
  working = true;
  try {
    await handleMessage(row);
  } catch (e) {
    console.error(`[relay] message ${row.id} failed: ${e.message}`);
  } finally {
    working = false;
    if (workQueue.length > 0) setImmediate(pump);
  }
}

async function handleMessage(row) {
  console.log(`[relay] message ${row.id} from=${row.from_agent} kind=${row.kind}: ${row.body.slice(0, 80)}`);
  await rest("PATCH", `agent_messages?id=eq.${row.id}`, { delivered_at: new Date().toISOString() });

  if (row.kind === "task") {
    // Escalate into the durable queue — existing pipeline takes it from here.
    const title = row.body.split("\n")[0].slice(0, 160);
    // task_queue.source has a CHECK constraint whose vocabulary is NOT the
    // agent-name vocabulary ('jeff'/'atlas'/'iris' are all rejected). Map to a
    // legal source and keep the true origin in context.
    const SOURCES = new Set(["cowork", "chat", "claude-code", "system", "desktop", "wren-scheduler", "dashboard"]);
    const source = SOURCES.has(row.from_agent) ? row.from_agent : "chat";
    const inserted = await rest("POST", "task_queue", {
      title,
      description: row.body,
      source,
      target: "claude-code",
      status: "pending",
      priority: 2,
      context: { relay_message_id: row.id, relay_from: row.from_agent, via: "message-relay" },
    }, { Prefer: "return=representation" });
    const taskId = inserted?.[0]?.id ?? null;
    await rest("PATCH", `agent_messages?id=eq.${row.id}`, { task_id: taskId, acked_at: new Date().toISOString() });
    await sendMessage(row.from_agent, `Queued as task ${taskId ?? "?"}: ${title}`, "status", row.thread_id ?? row.id, taskId, row.__hop ?? 0);
    return;
  }

  if (await killSwitchHalted()) {
    console.warn(`[relay] kill switch active — refusing to spawn for message ${row.id}`);
    logActivity(`Kill switch active — relay refused to handle message ${row.id}`);
    return;
  }

  const { ok, text: reply } = await runClaude(row);
  await sendMessage(row.from_agent, reply, "chat", row.thread_id ?? row.id, null, row.__hop ?? 0, !ok);
  await rest("PATCH", `agent_messages?id=eq.${row.id}`, { acked_at: new Date().toISOString() });
}

// Anything the relay generates automatically carries its hop count, and error
// reports are tagged so the receiving side never spawns a session for them.
function looksLikeError(body) {
  return /^\(relay|^\(atlas-helper|Failed to authenticate|API Error|OAuth session expired/i.test(String(body).trim());
}

async function sendMessage(toAgent, body, kind, threadId, taskId, hop = 0, isError = false) {
  if (threadId) repliesByThread.set(threadId, (repliesByThread.get(threadId) || 0) + 1);
  if (repliesByThread.size > 2000) repliesByThread.clear();
  await rest("POST", "agent_messages", {
    from_agent: AGENT,
    to_agent: toAgent === "jeff" ? "jeff" : toAgent,
    kind,
    body: body.slice(0, 60_000),
    thread_id: threadId,
    ...(taskId ? { task_id: taskId } : {}),
    meta: {
      via: "message-relay",
      hop: hop + 1,
      ...(isError || looksLikeError(body) ? { auto_error: true } : {}),
    },
  });
}

function framePrompt(row) {
  return [
    `You are Wren, handling a live Relay message on svc-podman-01 (headless session spawned by message-relay).`,
    `From: ${row.from_agent}${row.to_agent === null ? " (broadcast to all agents)" : ""}`,
    ``,
    `MESSAGE:`,
    row.body,
    ``,
    `Act on this directly if it is quick (read-only checks, small fixes, questions). If it needs`,
    `substantial or risky work, do NOT start it — say what you'd do and suggest queuing it as a task.`,
    `Your final message becomes the reply sent back to ${row.from_agent} on the Relay, so make it the`,
    `answer itself: concise, plain text, no preamble.`,
  ].join("\n");
}

// The service EnvironmentFile (memory-mcp .env) carries a stale
// ANTHROPIC_API_KEY that overrides Claude Code's OAuth credentials and makes
// every spawned session fail with "401 API key is invalid". Drop it so the
// child authenticates the same way an interactive session does.
function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function runClaude(row) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ["-p", "--output-format", "json", "--dangerously-skip-permissions"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv(),
    });
    let out = "", err = "";

    // Settle exactly once, and ALWAYS settle: a promise that never resolves
    // leaves `working` true and stalls the FIFO permanently — the relay goes
    // silent while still looking connected. (Hit on the Atlas side 2026-08-29.)
    let settled = false;
    let timedOut = false;
    const timeoutText = () =>
      `(relay: claude timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s and was killed. ` +
      `Partial output: ${(out || "(none)").slice(0, 500)}${err ? ` | stderr: ${err.slice(0, 300)}` : ""})`;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(typeof res === "string" ? { ok: false, text: res } : res);
    };

    // {ok, text} — ok must mean the session genuinely succeeded. Claude's JSON
    // carries is_error/subtype; an error string is not a result.
    const parseOut = (code) => {
      // A kill we initiated must not be reported as a plain non-zero exit.
      if (timedOut) return { ok: false, text: timeoutText() };
      if (code !== 0 && !out) {
        return { ok: false, text: `(relay error: session exited ${code}${err ? `: ${err.slice(0, 300)}` : ""})` };
      }
      try {
        const parsed = JSON.parse(out);
        const text = parsed.result ?? parsed.text ?? out.slice(0, 4000);
        const ok = code === 0 &&
                   parsed.is_error !== true &&
                   (parsed.subtype === undefined || parsed.subtype === "success") &&
                   !AUTH_FAIL_RE.test(String(text));
        return { ok, text };
      } catch {
        const text = out.trim().slice(0, 4000) || `(relay: empty response, exit ${code}${err ? `: ${err.slice(0, 300)}` : ""})`;
        return { ok: false, text };
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      console.warn(`[relay] claude timed out after ${CLAUDE_TIMEOUT_MS}ms — killing`);
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      setTimeout(() => finish({ ok: false, text: timeoutText() }), 2_000);
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("exit", (code) => { setTimeout(() => finish(parseOut(code)), 1_000); });
    child.on("close", (code) => finish(parseOut(code)));
    child.on("error", (e) => {
      finish({ ok: false, text: `(relay error: failed to spawn claude: ${e.message})` });
    });
    child.stdin.write(framePrompt(row));
    child.stdin.end();
  });
}

// ── task_queue fast pickup (replaces realtime_listener.py) ───────────────────

let queueTimer = null;
function onTaskInsert(rec) {
  const target = rec?.target ?? "";
  const status = rec?.status ?? "";
  if (!["claude-code", "wren", "auto"].includes(target)) return;
  if (!["pending", "ready", "delegated"].includes(status)) return;
  if (queueTimer) return; // debounce window already open
  queueTimer = setTimeout(() => {
    queueTimer = null;
    console.log(`[relay] task_queue INSERT (${rec.id ?? "?"}) — starting claude-queue-poll.service`);
    execFile("systemctl", ["--user", "start", "--no-block", "claude-queue-poll.service"], (e) => {
      if (e) console.warn(`[relay] poller start failed: ${e.message}`);
    });
  }, QUEUE_DEBOUNCE_MS);
}

// ── Catch-up on (re)connect ──────────────────────────────────────────────────

async function catchUp() {
  try {
    const rows = await rest("GET",
      `agent_messages?select=*&delivered_at=is.null&from_agent=not.in.(${[...MY_NAMES].join(",")})` +
      `&or=(to_agent.in.(${[...MY_NAMES].join(",")}),to_agent.is.null)` +
      `&kind=in.(chat,task)&created_at=gt.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}` +
      `&order=created_at.asc&limit=50`);
    if (rows?.length) {
      console.log(`[relay] catch-up: ${rows.length} undelivered message(s)`);
      rows.forEach(enqueueMessage);
    }
  } catch (e) {
    console.warn(`[relay] catch-up failed: ${e.message}`);
  }
}

// ── Phoenix v1.0.0 Realtime client (pattern: memory-mcp startMemorySyncListener)

const RT_URL = `${SUPABASE_URL.replace("https://", "wss://")}/realtime/v1/websocket?apikey=${ANON_KEY}&vsn=1.0.0`;
const TOPIC = "realtime:relay-wren";
let ws = null, heartbeat = null, retryTimer = null, ref = 0;

function cleanup() {
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

function connect() {
  cleanup();
  ws = new WebSocket(RT_URL);

  ws.on("open", () => {
    ref = 0;
    ws.send(JSON.stringify({
      topic: TOPIC,
      event: "phx_join",
      payload: { config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [
        { event: "INSERT", schema: "public", table: "agent_messages" },
        { event: "INSERT", schema: "public", table: "task_queue" },
      ] } },
      ref: String(++ref),
      join_ref: "1",
    }));
    heartbeat = setInterval(() => {
      ws?.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) }));
    }, 25_000);
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "phx_reply" && msg.payload?.status === "ok" && msg.topic === TOPIC) {
      console.log("[relay] Realtime subscription active (agent_messages + task_queue)");
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      catchUp();
      return;
    }

    if (msg.event === "postgres_changes") {
      const rec = msg.payload?.data?.record || msg.payload?.record;
      const table = msg.payload?.data?.table || msg.payload?.table;
      if (!rec) return;
      if (table === "agent_messages") enqueueMessage(rec);
      else if (table === "task_queue") onTaskInsert(rec);
    }
  });

  ws.on("error", (e) => {
    console.warn(`[relay] WS error: ${e.message} — reconnecting in 30s`);
    cleanup();
    retryTimer = setTimeout(connect, 30_000);
  });

  ws.on("close", () => {
    cleanup();
    retryTimer = setTimeout(connect, 30_000);
  });
}

console.log(`[relay] starting — agent=${AGENT}, claude=${CLAUDE_BIN}, timeout=${CLAUDE_TIMEOUT_MS}ms`);
connect();
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
