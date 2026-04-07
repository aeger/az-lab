// Direct Supabase REST client — for task queue, goals, and raw SQL
// Fallback when memory-mcp-server is unreachable

import { getConfig } from '../shared/config';
import type { Memory, Task, Goal } from '../shared/types';

async function supabaseRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const config = await getConfig();
  const url = `${config.supabaseUrl}/rest/v1/${path}`;

  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'Content-Type': 'application/json',
      Prefer: options.method === 'POST' ? 'return=representation' : 'return=minimal',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${options.method ?? 'GET'} ${path}: ${res.status} ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : ([] as unknown as T);
}

// --- Memories ---

export async function fetchMemories(type?: string, limit = 50): Promise<Memory[]> {
  let path = `memories?select=id,type,name,description,content,tags,source,created_at,updated_at,access_count&order=updated_at.desc&limit=${limit}`;
  if (type) path += `&type=eq.${type}`;
  return supabaseRequest<Memory[]>(path);
}

export async function fetchMemoryByName(name: string): Promise<Memory | null> {
  const results = await supabaseRequest<Memory[]>(
    `memories?name=eq.${encodeURIComponent(name)}&limit=1`
  );
  return results[0] ?? null;
}

export async function searchMemoriesKeyword(query: string, limit = 20): Promise<Memory[]> {
  // Full-text search via Supabase text search
  const tsQuery = query.split(/\s+/).join(' & ');
  return supabaseRequest<Memory[]>(
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
  // DELETE + INSERT pattern (no unique constraint on name)
  await supabaseRequest(`memories?name=eq.${encodeURIComponent(memory.name)}`, {
    method: 'DELETE',
  });
  await supabaseRequest('memories', {
    method: 'POST',
    body: { ...memory, source: memory.source ?? 'lumen' },
  });
}

// --- Task Queue ---

export async function fetchTasks(status?: string, limit = 20): Promise<Task[]> {
  let path = `task_queue?select=*&order=priority.asc,created_at.asc&limit=${limit}`;
  if (status) path += `&status=eq.${status}`;
  return supabaseRequest<Task[]>(path);
}

export async function fetchPendingTasks(): Promise<Task[]> {
  return fetchTasks('pending');
}

export async function createTask(task: {
  title: string;
  description: string;
  target: string;
  priority?: number;
  tags?: string[];
  context?: Record<string, unknown>;
}): Promise<Task[]> {
  return supabaseRequest<Task[]>('task_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: {
      ...task,
      priority: task.priority ?? 2,
      source: 'claude-code', // Lumen uses claude-code source per check constraint
      tags: task.tags ?? [],
      context: task.context ?? {},
    },
  });
}

export async function updateTaskStatus(
  id: string,
  status: string,
  result?: string,
  error?: string
): Promise<void> {
  await supabaseRequest(`task_queue?id=eq.${id}`, {
    method: 'PATCH',
    body: { status, ...(result && { result }), ...(error && { error }) },
  });
}

// --- Goals ---

export async function fetchGoals(status?: string): Promise<Goal[]> {
  let path = `goals?select=*&order=priority.asc,created_at.desc&limit=20`;
  if (status) path += `&status=eq.${status}`;
  return supabaseRequest<Goal[]>(path);
}

// --- Shared Agent Context ---

export async function fetchSharedContext(): Promise<string | null> {
  const results = await supabaseRequest<Memory[]>(
    `memories?name=eq.shared_agent_context&select=content&limit=1`
  );
  return results[0]?.content ?? null;
}

export async function updateSharedContext(content: string): Promise<void> {
  await supabaseRequest(`memories?name=eq.shared_agent_context`, {
    method: 'PATCH',
    body: { content, source: 'lumen', updated_at: new Date().toISOString() },
  });
}

// --- Raw SQL (via PostgREST RPC) ---

export async function executeSql(query: string): Promise<unknown> {
  // Note: This uses the rpc endpoint if available, otherwise falls back
  // For complex queries, prefer specific REST endpoints above
  const config = await getConfig();
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: config.supabaseAnonKey,
      Authorization: `Bearer ${config.supabaseAnonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    // exec_sql RPC may not exist — this is a nice-to-have
    return null;
  }
  return res.json();
}
