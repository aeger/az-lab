// Lumen — az-lab browser agent configuration

export const AGENT_NAME = 'lumen';
export const AGENT_DISPLAY_NAME = 'Lumen';
export const AGENT_ROLE = 'Browser agent — eyes on the internet';

// Endpoints (defaults — overridable via options page)
export const DEFAULT_CONFIG = {
  // Chat backend — Ollama is default (free, local on svc-podman-01)
  ollamaUrl: 'http://192.168.1.181:11434',
  ollamaModel: 'llama3.1:8b',
  // Anthropic API is optional fallback (only used if API key is set)
  anthropicModel: 'claude-sonnet-4-6',
  // az-lab services
  memoryMcpUrl: 'https://memory-mcp.az-lab.dev/mcp',
  memoryHealthUrl: 'https://memory-mcp.az-lab.dev/health',
  supabaseUrl: 'https://ogqjjlbupqnvlcyrfnxi.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDU1NzYsImV4cCI6MjA4OTYyMTU3Nn0.VVvHOmcR04gnVHa6k8_lHhdCt6zNhpHYbj4c68LkScc',
  agentBusUrl: 'http://192.168.1.181:8765',
} as const;

// Storage keys
export const STORAGE_KEYS = {
  config: 'lumen_config',
  anthropicApiKey: 'lumen_anthropic_key',
  mcpSessionId: 'lumen_mcp_session',
  feedbackMemories: 'lumen_feedback_memories',
  sessionContext: 'lumen_session_context',
  lastStartup: 'lumen_last_startup',
} as const;

// Alarm names (chrome.alarms for periodic tasks)
export const ALARMS = {
  heartbeat: 'lumen-heartbeat',
  taskPoll: 'lumen-task-poll',
  memorySync: 'lumen-memory-sync',
} as const;

export type LumenConfig = {
  ollamaUrl: string;
  ollamaModel: string;
  anthropicModel: string;
  anthropicApiKey?: string;
  memoryMcpUrl: string;
  memoryHealthUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  agentBusUrl: string;
};

export async function getConfig(): Promise<LumenConfig> {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.config,
    STORAGE_KEYS.anthropicApiKey,
  ]);
  const overrides = stored[STORAGE_KEYS.config] ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    anthropicApiKey: stored[STORAGE_KEYS.anthropicApiKey],
  };
}

export async function saveConfig(config: Partial<LumenConfig>): Promise<void> {
  const { anthropicApiKey, ...rest } = config;
  if (anthropicApiKey !== undefined) {
    await chrome.storage.local.set({ [STORAGE_KEYS.anthropicApiKey]: anthropicApiKey });
  }
  if (Object.keys(rest).length > 0) {
    const existing = (await chrome.storage.local.get(STORAGE_KEYS.config))[STORAGE_KEYS.config] ?? {};
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: { ...existing, ...rest } });
  }
}
