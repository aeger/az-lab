// Direct Supabase REST client for reads; writes route through Agent Bus
// (Hermes) which holds the server-side secret key.
//
// Writes return a strict envelope: { ok, status_code, rows_affected, rows, error? }.
// We throw on `ok === false` so callers never mistake a silent denial for success.
// This is the fix for the 2026-05-28 hallucination loop where the publishable
// key was denied by RLS and Lumen claimed completions that never happened.

import { getConfig } from '../shared/config';
import type { Memory, Task, Goal } from '../shared/types';

type BusWriteEnvelope<R = Record<string, unknown>> = {
  ok: boolean;
  status_code: number;
  rows_affected: number;
  rows?: R[];
  error?: string;
};

type WriteOp =
  | { op: 'insert'; values: Record<string, unknown> | Record<string, unknown>[] }
  | { op: 'upsert'; values: Record<string, unknown> | Record<string, unknown>[]; on_conflict: string }
  | { op: 'update'; patch: Record<string, unknown>; filter: Record<string, string> }
  | { op: 'delete'; filter: Record<string, string> };

async function busWrite<R = Record<string, unknown>>(
  table: 'task_queue' | 'memories' | 'agent_activity' | 'sentinel_notifications',
  payload: WriteOp
): Promise<BusWriteEnvelope<R>> {
  const config = await getConfig();
  let res: Response;
  try {
    res = await fetch(`${config.agentBusUrl}/writes/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Secret': 'azlab-agent-bus',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    throw new Error(`Agent Bus unreachable for ${table}.${payload.op}: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Transport error — bus itself rejected the request (auth, not-found, parse).
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Agent Bus /writes/${table} HTTP ${res.status}: ${body}`);
  }

  let env: BusWriteEnvelope<R>;
  try {
    env = await res.json();
  } catch {
    throw new Error(`Agent Bus /writes/${table}: invalid JSON response`);
  }

  // Application-level failure — RLS denial, 0 rows affected, bad input, etc.
  // The whole point of these wrappers: surface this as a real error so the LLM
  // can't claim a write succeeded when it didn't.
  if (!env.ok) {
    throw new Error(
      `Agent Bus ${payload.op} ${table} failed: ${env.error ?? 'unknown'} ` +
      `(status=${env.status_code}, rows_affected=${env.rows_affected})`
    );
  }
  return env;
}

async function supabaseRead<T>(path: string): Promise<T> {
  const config = await getConfig();
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET ${path}: ${res.status} ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : ([] as unknown as T);
}

// --- Memories ---

export async function fetchMemories(type?: string, limit = 50): Promise<Memory[]> {
  let path = `memories?select=id,type,name,description,content,tags,source,created_at,updated_at,access_count&order=updated_at.desc&limit=${limit}`;
  if (type) path += `&type=eq.${type}`;
  return supabaseRead<Memory[]>(path);
}

export async function fetchMemoryByName(name: string): Promise<Memory | null> {
  const results = await supabaseRead<Memory[]>(
    `memories?name=eq.${encodeURIComponent(name)}&limit=1`
  );
  return results[0] ?? null;
}

export async function searchMemoriesKeyword(query: string, limit = 20): Promise<Memory[]> {
  return supabaseRead<Memory[]>(
    `memories?or=(name.ilike.*${encodeURIComponent(query)}*,description.ilike.*${encodeURIComponent(query)}*,content.ilike.*${encodeURIComponent(query)}*)&order=updated_at.desc&limit=${limit}`
  );
}

export async function upsertMemory(memory: {
  name: string;
  type: string;
  description: string;
  content: string;
  tags?: string[];
  source?: string;
}): Promise<void> {
  // DELETE + INSERT (no unique constraint on name). Each step throws on failure.
  await busWrite('memories', {
    op: 'delete',
    filter: { name: `eq.${memory.name}` },
  });
  await busWrite('memories', {
    op: 'insert',
    values: { ...memory, source: memory.source ?? 'lumen' },
  });
}

// --- Task Queue ---

// Statuses considered "active" (not terminal/parked) for the default Tasks view + badge.
const TERMINAL_STATUSES = ['completed', 'cancelled', 'archived'];

export async function fetchTasks(status?: string, limit = 50): Promise<Task[]> {
  // Exclude archived rows always; order newest-first so recent work is on top
  // (the old priority.asc,created_at.asc buried current tasks under ancient ones).
  let path = `task_queue?select=*&archived_at=is.null&order=priority.asc,updated_at.desc&limit=${limit}`;
  if (status === 'active') {
    path += `&status=not.in.(${TERMINAL_STATUSES.join(',')})`;
  } else if (status) {
    path += `&status=eq.${status}`;
  }
  return supabaseRead<Task[]>(path);
}

// Active (non-terminal) tasks — drives the toolbar badge count.
export async function fetchPendingTasks(): Promise<Task[]> {
  return fetchTasks('active');
}

export async function createTask(task: {
  title: string;
  description: string;
  target: string;
  priority?: number;
  tags?: string[];
  context?: Record<string, unknown>;
}): Promise<Task[]> {
  const env = await busWrite<Task>('task_queue', {
    op: 'insert',
    values: {
      ...task,
      priority: task.priority ?? 2,
      source: 'claude-code', // Lumen uses claude-code source per check constraint
      tags: task.tags ?? [],
      context: task.context ?? {},
    },
  });
  return env.rows ?? [];
}

export async function updateTaskStatus(
  id: string,
  status: string,
  result?: string,
  error?: string
): Promise<void> {
  await busWrite('task_queue', {
    op: 'update',
    filter: { id: `eq.${id}` },
    patch: { status, ...(result && { result }), ...(error && { error }) },
  });
}

// --- Goals (read-only from Lumen) ---

export async function fetchGoals(status?: string): Promise<Goal[]> {
  let path = `goals?select=*&order=priority.asc,created_at.desc&limit=20`;
  if (status) path += `&status=eq.${status}`;
  return supabaseRead<Goal[]>(path);
}

// --- Shared Agent Context ---

export async function fetchSharedContext(): Promise<string | null> {
  const results = await supabaseRead<Memory[]>(
    `memories?name=eq.shared_agent_context&select=content&limit=1`
  );
  return results[0]?.content ?? null;
}

export async function updateSharedContext(content: string): Promise<void> {
  await busWrite('memories', {
    op: 'update',
    filter: { name: 'eq.shared_agent_context' },
    patch: { content, source: 'lumen', updated_at: new Date().toISOString() },
  });
}
