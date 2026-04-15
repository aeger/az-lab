// Lumen — az-lab browser agent configuration

export const AGENT_NAME = 'lumen';
export const AGENT_DISPLAY_NAME = 'Lumen';
export const AGENT_ROLE = 'Browser agent — eyes on the internet';

// Endpoints (defaults — overridable via options page)
export const DEFAULT_CONFIG = {
  memoryMcpUrl: 'https://memory-mcp.az-lab.dev/mcp',
  memoryHealthUrl: 'https://memory-mcp.az-lab.dev/health',
  supabaseUrl: 'https://ogqjjlbupqnvlcyrfnxi.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNDU1NzYsImV4cCI6MjA4OTYyMTU3Nn0.VVvHOmcR04gnVHa6k8_lHhdCt6zNhpHYbj4c68LkScc',
  agentBusUrl: 'http://192.168.1.181:8765',
  sentinelApiUrl: 'https://sentinel-api.az-lab.dev',
  sentinelApiKey: 'sentinel-c81bbb17bb17df0f46787983da69bcb40c7779a9e1292376',
  anthropicModel: 'claude-sonnet-4-6',
} as const;

// Storage keys
export const STORAGE_KEYS = {
  config: 'lumen_config',
  anthropicApiKey: 'lumen_anthropic_key',
  mcpSessionId: 'lumen_mcp_session',
  feedbackMemories: 'lumen_feedback_memories',
  sessionContext: 'lumen_session_context',
  lastStartup: 'lumen_last_startup',
  lastNotifId: 'lumen_last_notif_id',        // dedup: last seen notification receivedAt
  soundPrefs: 'lumen_sound_prefs',           // per-urgency sound preferences
  notifHistory: 'lumen_notif_history',       // local notification cache
} as const;

// Alarm names (chrome.alarms for periodic tasks)
export const ALARMS = {
  heartbeat: 'lumen-heartbeat',
  taskPoll: 'lumen-task-poll',
  memorySync: 'lumen-memory-sync',
  notifPoll: 'lumen-notif-poll',
} as const;

export type LumenConfig = {
  memoryMcpUrl: string;
  memoryHealthUrl: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  agentBusUrl: string;
  sentinelApiUrl: string;
  sentinelApiKey: string;
  anthropicModel: string;
  anthropicApiKey?: string;
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
