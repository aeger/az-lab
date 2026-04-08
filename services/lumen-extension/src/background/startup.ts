// Lumen startup protocol — mirrors other agents' startup sequence

import { STORAGE_KEYS, AGENT_NAME, getConfig } from '../shared/config';
import { mcpHealthCheck, mcpInitialize } from './mcp-client';
import { fetchMemories, fetchPendingTasks, fetchSharedContext } from './supabase';
import { busHealthCheck } from './agent-bus';
import type { AgentStatus } from '../shared/types';

export interface StartupResult {
  status: AgentStatus;
  feedbackRules: string[];
  pendingTasks: number;
  sharedContext: string | null;
}

export async function runStartup(): Promise<StartupResult> {
  console.log(`[${AGENT_NAME}] Running startup protocol...`);

  // Check connectivity in parallel
  const [mcpOk, busOk, feedbackMemories, tasks, sharedCtx] = await Promise.allSettled([
    mcpHealthCheck(),
    busHealthCheck(),
    fetchMemories('feedback'),
    fetchPendingTasks(),
    fetchSharedContext(),
  ]);

  const mcpConnected = mcpOk.status === 'fulfilled' && mcpOk.value;
  const busConnected = busOk.status === 'fulfilled' && busOk.value;
  const supabaseOk = feedbackMemories.status === 'fulfilled';

  // Initialize MCP session if server is up
  if (mcpConnected) {
    await mcpInitialize().catch(() => {});
  }

  // Extract feedback rules for local cache
  const feedbackRules: string[] = [];
  if (feedbackMemories.status === 'fulfilled') {
    for (const mem of feedbackMemories.value) {
      feedbackRules.push(`[${mem.name}]: ${mem.content}`);
    }
  }

  // Cache feedback rules locally for fast access
  await chrome.storage.local.set({
    [STORAGE_KEYS.feedbackMemories]: feedbackRules,
    [STORAGE_KEYS.lastStartup]: Date.now(),
  });

  const pendingCount = tasks.status === 'fulfilled' ? tasks.value.length : 0;
  const context = sharedCtx.status === 'fulfilled' ? sharedCtx.value : null;

  if (context) {
    await chrome.storage.local.set({ [STORAGE_KEYS.sessionContext]: context });
  }

  const status: AgentStatus = {
    memoryMcp: mcpConnected ? 'connected' : 'disconnected',
    supabase: supabaseOk ? 'connected' : 'disconnected',
    agentBus: busConnected ? 'connected' : 'disconnected',
    chatBackend: 'configured', // Ollama is default, no key needed
  };

  // Check chat backend availability
  const stored = await chrome.storage.local.get(STORAGE_KEYS.anthropicApiKey);
  if (stored[STORAGE_KEYS.anthropicApiKey]) {
    status.chatBackend = 'configured'; // Using Anthropic API
  } else {
    // Check if Ollama is reachable
    try {
      const config = await getConfig();
      const ollamaRes = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      status.chatBackend = ollamaRes.ok ? 'connected' : 'error';
    } catch {
      status.chatBackend = 'disconnected'; // Ollama unreachable
    }
  }

  console.log(`[${AGENT_NAME}] Startup complete:`, {
    mcp: status.memoryMcp,
    supabase: status.supabase,
    bus: status.agentBus,
    chat: status.chatBackend,
    feedbackRules: feedbackRules.length,
    pendingTasks: pendingCount,
  });

  return { status, feedbackRules, pendingTasks: pendingCount, sharedContext: context };
}
