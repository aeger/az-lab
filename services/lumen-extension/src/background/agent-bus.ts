// Agent Bus client — connects to Hermes at svc-podman-01:8765

import { getConfig } from '../shared/config';

interface AgentBusStatus {
  status: string;
  uptime?: number;
  presence?: string;
  pending_count?: number;
}

async function busRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const config = await getConfig();
  const url = `${config.agentBusUrl}${path}`;

  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Secret': import.meta.env.VITE_AGENT_BUS_SECRET as string,
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Agent Bus ${options.method ?? 'GET'} ${path}: ${res.status}`);
  }

  return res.json() as Promise<T>;
}

// --- Public API ---

export async function busHealthCheck(): Promise<boolean> {
  try {
    await busRequest<{ status: string }>('/health');
    return true;
  } catch {
    return false;
  }
}

export async function busGetStatus(): Promise<AgentBusStatus> {
  return busRequest<AgentBusStatus>('/health');
}

export interface SecurityStatus {
  level: 'connected' | 'error' | 'disconnected' | 'unknown'; // → dot CSS class
  score: number | null;
}

// Security posture for the status dot. Reads the scanner output via the bus
// (/security). score >= 80 green, 60-79 amber, < 60 red, no data grey.
export async function busGetSecurity(): Promise<SecurityStatus> {
  try {
    const { score } = await busRequest<{ score: number | null }>('/security');
    if (typeof score !== 'number') return { level: 'unknown', score: null };
    const level = score >= 80 ? 'connected' : score >= 60 ? 'error' : 'disconnected';
    return { level, score };
  } catch {
    return { level: 'unknown', score: null };
  }
}

export async function busSendDiscord(message: string, channel?: string): Promise<void> {
  // Use MCP endpoint for tool calls
  await busRequest('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'send_discord',
        arguments: { message, channel: channel ?? 'claude-code' },
      },
    },
  });
}

export async function busFireTrigger(trigger: string, data?: Record<string, unknown>): Promise<void> {
  await busRequest('/trigger', {
    method: 'POST',
    body: { trigger, data },
  });
}

export async function busQueueTask(task: {
  title: string;
  description: string;
  target?: string;
  priority?: number;
  tags?: string[];
}): Promise<void> {
  await busRequest('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'queue_task',
        arguments: {
          title: task.title,
          description: task.description,
          target: task.target ?? 'wren',
          priority: task.priority ?? 2,
          tags: task.tags ?? [],
        },
      },
    },
  });
}
