#!/usr/bin/env node
// atlas-helper — Atlas's realtime listener for the agent Relay pathway.
// Runs on Jeff's Windows PC as a Scheduled Task (see install-atlas-helper.ps1).
//
// Mirrors message-relay on svc-podman-01: raw Phoenix v1.0.0 WebSocket to
// Supabase Realtime (supabase-js's vsn=2.0.0 is rejected by this project),
// watching INSERTs on agent_messages (to atlas / broadcast) and task_queue
// (target=atlas). On a message: toast Jeff (BurntToast), check the kill
// switch, spawn `claude -p` headlessly, and post the session's final output
// back as the reply row. kind='task' queue rows toast only unless
// auto_execute_tasks is enabled in config.json.
//
// Config: config.json next to this file (see config.example.json).

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// Strip a UTF-8 BOM before parsing: Notepad and PowerShell's Set-Content both
// write one, and JSON.parse throws on it with a baffling error.
const cfg = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8").replace(/^﻿/, ""));

const SUPABASE_URL = cfg.supabase_url;
const ANON_KEY = cfg.supabase_publishable_key;
const SECRET_KEY = cfg.supabase_secret_key;
const AGENT = cfg.agent_name || "atlas";
const CLAUDE_BIN = cfg.claude_bin || "claude";
const CLAUDE_ARGS = cfg.claude_args || ["-p", "--output-format", "json", "--permission-mode", "acceptEdits"];
const CLAUDE_CWD = cfg.claude_cwd || process.env.USERPROFILE || HERE;
const CLAUDE_TIMEOUT_MS = cfg.claude_timeout_ms || 300_000;
const AUTO_EXECUTE_TASKS = cfg.auto_execute_tasks === true;
const TOAST = cfg.toast !== false;

if (!SUPABASE_URL || !ANON_KEY || !SECRET_KEY) {
  console.error("[atlas-helper] config.json needs supabase_url, supabase_publishable_key, supabase_secret_key");
  process.exit(1);
}

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

// ── Status file (read by the tray app; harmless when running headless) ───────
// atlas-tray.ps1 polls this to drive the tray icon, tooltip and balloon
// notifications. notify_seq increments on every user-visible event so the tray
// can show a balloon without needing BurntToast installed.
const STATUS_PATH = join(HERE, "status.json");
const status = {
  pid: process.pid,
  agent: AGENT,
  connected: false,
  started_at: new Date().toISOString(),
  connected_at: null,
  last_event_at: null,
  messages_handled: 0,
  tasks_handled: 0,
  busy: false,
  auto_execute_tasks: AUTO_EXECUTE_TASKS,
  notify_seq: 0,
  notify_title: "",
  notify_body: "",
  last_error: null,
};

function writeStatus() {
  try {
    const tmp = `${STATUS_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(status, null, 2));
    renameSync(tmp, STATUS_PATH); // atomic-ish: tray never reads a half-written file
  } catch { /* status is best-effort — never break the listener over it */ }
}

function notify(title, body) {
  status.notify_seq += 1;
  status.notify_title = String(title).slice(0, 120);
  status.notify_body = String(body).slice(0, 400);
  status.last_event_at = new Date().toISOString();
  writeStatus();
}

setInterval(writeStatus, 30_000).unref?.();
writeStatus();

function toast(title, body) {
  notify(title, body);   // always publish to the tray
  if (!TOAST) return;    // BurntToast is the optional extra path
  const psBody = String(body).slice(0, 180).replace(/'/g, "''");
  const psTitle = String(title).slice(0, 60).replace(/'/g, "''");
  const script = `try { Import-Module BurntToast -ErrorAction Stop; New-BurntToastNotification -Text '${psTitle}','${psBody}' } catch { msg * '${psTitle}: ${psBody}' }`;
  spawn("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore", detached: true }).unref();
}

async function killSwitchHalted() {
  try {
    const rows = await rest("POST", "rpc/check_kill_switch", { p_agent: AGENT });
    return Array.isArray(rows) && rows.some(r => r.halted);
  } catch (e) {
    console.warn(`[atlas-helper] kill-switch check failed (${e.message}) — proceeding cautiously`);
    return false;
  }
}

// ── Message handling ─────────────────────────────────────────────────────────

const seen = new Set();
const workQueue = [];
let working = false;

function enqueueMessage(row) {
  if (!row || seen.has(row.id)) return;
  if (row.to_agent !== AGENT && row.to_agent !== null) return;
  if (row.from_agent === AGENT) return;
  if (row.kind === "status" || row.kind === "system" || row.kind === "task") return;
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
  status.busy = true;
  writeStatus();
  try {
    await handleMessage(row);
    status.messages_handled += 1;
  } catch (e) {
    console.error(`[atlas-helper] message ${row.id} failed: ${e.message}`);
    status.last_error = `${new Date().toISOString()} ${e.message}`.slice(0, 300);
  } finally {
    working = false;
    status.busy = false;
    writeStatus();
    if (workQueue.length > 0) setImmediate(pump);
  }
}

async function handleMessage(row) {
  console.log(`[atlas-helper] message ${row.id} from=${row.from_agent}: ${row.body.slice(0, 80)}`);
  toast(`Relay: ${row.from_agent} → atlas`, row.body);
  await rest("PATCH", `agent_messages?id=eq.${row.id}`, { delivered_at: new Date().toISOString() });

  if (await killSwitchHalted()) {
    console.warn(`[atlas-helper] kill switch active — refusing to spawn for ${row.id}`);
    return;
  }

  const reply = await runClaude(framePrompt(row));
  await rest("POST", "agent_messages", {
    from_agent: AGENT,
    to_agent: row.from_agent,
    kind: "chat",
    body: reply.slice(0, 60_000),
    thread_id: row.thread_id ?? row.id,
    meta: { via: "atlas-helper" },
  });
  await rest("PATCH", `agent_messages?id=eq.${row.id}`, { acked_at: new Date().toISOString() });
}

function framePrompt(row) {
  return [
    `You are Atlas, handling a live Relay message on the Windows workstation (headless session spawned by atlas-helper).`,
    `From: ${row.from_agent}${row.to_agent === null ? " (broadcast to all agents)" : ""}`,
    ``,
    `MESSAGE:`,
    row.body,
    ``,
    `Act on this directly if it is quick (file checks, OneDrive/Obsidian ops, questions). If it needs`,
    `substantial or risky work, do NOT start it — say what you'd do and suggest queuing it as a task.`,
    `Your final message becomes the reply sent back to ${row.from_agent} on the Relay, so make it the`,
    `answer itself: concise, plain text, no preamble.`,
  ].join("\n");
}

// A stale ANTHROPIC_API_KEY in the environment overrides Claude Code's OAuth
// credentials and fails every spawn with "401 API key is invalid" (hit on the
// Wren side 2026-08-29). Drop it so the child authenticates like an
// interactive session.
function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, CLAUDE_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: CLAUDE_CWD,
      env: childEnv(),
      shell: process.platform === "win32", // claude is a .cmd shim on Windows installs
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      console.warn(`[atlas-helper] claude timed out after ${CLAUDE_TIMEOUT_MS}ms — killing`);
      child.kill("SIGKILL");
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !out) {
        resolve(`(atlas-helper error: session exited ${code}${err ? `: ${err.slice(0, 200)}` : ""})`);
        return;
      }
      try {
        const parsed = JSON.parse(out);
        resolve(parsed.result ?? parsed.text ?? out.slice(0, 4000));
      } catch {
        resolve(out.trim().slice(0, 4000) || `(atlas-helper: empty response, exit ${code})`);
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve(`(atlas-helper error: failed to spawn claude: ${e.message})`);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ── task_queue: target=atlas rows ────────────────────────────────────────────

const seenTasks = new Set();

async function onTaskInsert(rec) {
  if (!rec || rec.target !== AGENT || seenTasks.has(rec.id)) return;
  if (!["pending", "ready"].includes(rec.status ?? "")) return;
  seenTasks.add(rec.id);
  console.log(`[atlas-helper] task ${rec.id} for atlas: ${rec.title ?? ""}`);
  toast("Atlas task queued", rec.title ?? rec.id);

  if (!AUTO_EXECUTE_TASKS) return;
  if (await killSwitchHalted()) return;

  try {
    const claimed = await rest("PATCH",
      `task_queue?id=eq.${rec.id}&status=eq.${rec.status}`,
      { status: "claimed", claimed_by: "atlas-helper", claimed_at: new Date().toISOString() },
      { Prefer: "return=representation" });
    if (!claimed?.length) return; // someone else got it
    const prompt = [
      `You are Atlas executing task_queue task ${rec.id} on the Windows workstation (headless).`,
      `TITLE: ${rec.title ?? ""}`,
      ``,
      `DESCRIPTION:`,
      rec.description ?? "",
      ``,
      `Do the work. Your final message is stored as the task result — report what you actually did.`,
    ].join("\n");
    status.busy = true;
    writeStatus();
    const result = await runClaude(prompt);
    await rest("PATCH", `task_queue?id=eq.${rec.id}`, { status: "completed", result: result.slice(0, 60_000) });
    status.tasks_handled += 1;
    status.busy = false;
    toast("Atlas task completed", rec.title ?? rec.id);
  } catch (e) {
    console.error(`[atlas-helper] task ${rec.id} failed: ${e.message}`);
    await rest("PATCH", `task_queue?id=eq.${rec.id}`, { status: "failed", error: String(e.message).slice(0, 500) }).catch(() => {});
  }
}

// ── Catch-up on (re)connect ──────────────────────────────────────────────────

async function catchUp() {
  try {
    const rows = await rest("GET",
      `agent_messages?select=*&delivered_at=is.null&from_agent=neq.${AGENT}` +
      `&or=(to_agent.eq.${AGENT},to_agent.is.null)&kind=eq.chat` +
      `&created_at=gt.${encodeURIComponent(new Date(Date.now() - 7 * 864e5).toISOString())}` +
      `&order=created_at.asc&limit=50`);
    if (rows?.length) {
      console.log(`[atlas-helper] catch-up: ${rows.length} undelivered message(s)`);
      rows.forEach(enqueueMessage);
    }
    const tasks = await rest("GET",
      `task_queue?select=id,title,description,status,target&target=eq.${AGENT}` +
      `&status=in.(pending,ready)&archived_at=is.null&order=created_at.asc&limit=20`);
    for (const t of tasks ?? []) await onTaskInsert(t);
  } catch (e) {
    console.warn(`[atlas-helper] catch-up failed: ${e.message}`);
  }
}

// ── Phoenix v1.0.0 Realtime client ───────────────────────────────────────────

const RT_URL = `${SUPABASE_URL.replace("https://", "wss://")}/realtime/v1/websocket?apikey=${ANON_KEY}&vsn=1.0.0`;
const TOPIC = "realtime:relay-atlas";
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
      console.log("[atlas-helper] Realtime subscription active (agent_messages + task_queue)");
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      status.connected = true;
      status.connected_at = new Date().toISOString();
      status.last_error = null;
      writeStatus();
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
    console.warn(`[atlas-helper] WS error: ${e.message} — reconnecting in 30s`);
    status.connected = false;
    status.last_error = `${new Date().toISOString()} WS: ${e.message}`.slice(0, 300);
    writeStatus();
    cleanup();
    retryTimer = setTimeout(connect, 30_000);
  });

  ws.on("close", () => {
    status.connected = false;
    writeStatus();
    cleanup();
    retryTimer = setTimeout(connect, 30_000);
  });
}

console.log(`[atlas-helper] starting — agent=${AGENT}, claude=${CLAUDE_BIN}, auto_execute_tasks=${AUTO_EXECUTE_TASKS}`);
connect();
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT", () => { cleanup(); process.exit(0); });
