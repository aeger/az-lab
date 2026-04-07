// MCP Client — connects to memory-mcp-server via HTTP + SSE
// Protocol: StreamableHTTPServerTransport (JSON-RPC over HTTP with SSE responses)

import { getConfig, STORAGE_KEYS } from '../shared/config';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let requestId = 0;
let sessionId: string | null = null;

async function loadSessionId(): Promise<string | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.mcpSessionId);
  sessionId = stored[STORAGE_KEYS.mcpSessionId] ?? null;
  return sessionId;
}

async function saveSessionId(id: string): Promise<void> {
  sessionId = id;
  await chrome.storage.local.set({ [STORAGE_KEYS.mcpSessionId]: id });
}

async function clearSession(): Promise<void> {
  sessionId = null;
  await chrome.storage.local.remove(STORAGE_KEYS.mcpSessionId);
}

async function mcpRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
  const config = await getConfig();
  const url = config.memoryMcpUrl;

  const body: JsonRpcRequest = {
    jsonrpc: '2.0',
    id: ++requestId,
    method,
    params,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (!sessionId) {
    await loadSessionId();
  }
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  // Capture session ID from response headers
  const newSessionId = response.headers.get('mcp-session-id');
  if (newSessionId && newSessionId !== sessionId) {
    await saveSessionId(newSessionId);
  }

  const contentType = response.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    // SSE response — parse events
    return parseSSEResponse(response);
  }

  // Direct JSON response
  if (!response.ok) {
    throw new Error(`MCP request failed: ${response.status} ${response.statusText}`);
  }

  const result: JsonRpcResponse = await response.json();
  if (result.error) {
    throw new Error(`MCP error: ${result.error.message}`);
  }
  return result.result;
}

async function parseSSEResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';
  let lastResult: unknown = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const parsed: JsonRpcResponse = JSON.parse(data);
          if (parsed.error) {
            throw new Error(`MCP error: ${parsed.error.message}`);
          }
          lastResult = parsed.result;
        } catch (e) {
          if (e instanceof SyntaxError) continue; // skip non-JSON SSE lines
          throw e;
        }
      }
    }
  }

  return lastResult;
}

// --- Public API ---

export async function mcpInitialize(): Promise<boolean> {
  try {
    await clearSession();
    await mcpRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lumen-extension', version: '0.1.0' },
    });
    return true;
  } catch {
    return false;
  }
}

export async function mcpHealthCheck(): Promise<boolean> {
  try {
    const config = await getConfig();
    const res = await fetch(config.memoryHealthUrl, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function mcpCallTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  return mcpRequest('tools/call', { name, arguments: args });
}

export async function mcpListTools(): Promise<unknown> {
  return mcpRequest('tools/list', {});
}

// Convenience wrappers for common memory operations

export async function searchMemories(query: string, options?: { type?: string; tags?: string[]; limit?: number }): Promise<unknown> {
  return mcpCallTool('search_memories', { query, ...options });
}

export async function storeMemory(args: {
  name: string;
  type: string;
  description: string;
  content: string;
  tags?: string[];
}): Promise<unknown> {
  return mcpCallTool('store_memory', { ...args, source: 'lumen' });
}

export async function listMemories(type?: string): Promise<unknown> {
  return mcpCallTool('list_memories', type ? { type } : {});
}

export async function forgetMemory(name: string): Promise<unknown> {
  return mcpCallTool('forget', { name });
}

export async function searchSkills(query: string): Promise<unknown> {
  return mcpCallTool('search_skills', { query });
}

export { clearSession as mcpClearSession };
