/**
 * Startup migration runner.
 * Calls idempotent RPC functions registered in Supabase.
 * If a function isn't registered yet, logs a message pointing to the SQL file.
 */
import { config } from '../config';

async function callRpc(fnName: string, params: Record<string, unknown> = {}): Promise<{ data: unknown; error: string | null }> {
  const key = config.supabase.serviceKey || config.supabase.anonKey;
  if (!config.supabase.url || !key) return { data: null, error: 'supabase not configured' };

  const res = await fetch(`${config.supabase.url}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (res.status === 404 || res.status === 400) {
    const body = await res.text();
    // PGRST202 = function not found in schema cache
    if (body.includes('PGRST202') || body.includes('not found')) {
      return { data: null, error: 'PGRST202' };
    }
    return { data: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  if (!res.ok) {
    const text = await res.text();
    return { data: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  const data = await res.json();
  return { data, error: null };
}

/** Run pending migrations at startup. Gracefully skips if DB not configured. */
export async function runMigrations(): Promise<void> {
  if (!config.supabase.url || !(config.supabase.serviceKey || config.supabase.anonKey)) {
    console.log('[migrate] supabase not configured — skipping migrations');
    return;
  }

  // Phase 4: Guardian + Sound Director + Weekly Reports tables
  try {
    const { data, error } = await callRpc('apply_sentinel_phase4_if_missing');
    if (error === 'PGRST202') {
      console.log('[migrate] phase4 RPC not yet registered — apply migrations/004_phase4_intelligence.sql in Supabase SQL editor.');
      console.log('[migrate] URL: https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new');
    } else if (error) {
      console.warn(`[migrate] phase4 error: ${error}`);
    } else {
      console.log(`[migrate] phase4: ${data}`);
    }
  } catch (err) {
    console.error('[migrate] phase4 unexpected error:', (err as Error).message);
  }
}
