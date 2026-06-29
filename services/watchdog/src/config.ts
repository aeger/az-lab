/**
 * config.ts — Configuration loader from environment variables or .env file
 * All values are configurable — no hardcoded paths or constants in other modules.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WatchdogConfig {
  staleThresholdSec: number;
  canaryTimeoutSec: number;
  maxRestartsHour: number;
  breakerCooldownSec: number;
  proactivePromptLimit: number;
  watchdogDir: string;
  heartbeatFile: string;
  stateFile: string;
  /** Circuit-breaker state — kept in its OWN file so the watchdog StateManager
   * can never clobber the recorded restart history (2026-06-16 loop bug). */
  breakerStateFile: string;
  counterFile: string;
  /** Hang detector — epoch-sec of last genuine inbound prompt. */
  lastPromptAtFile: string;
  /** Hang detector — epoch-sec of last genuine response delivered. */
  lastResponseAtFile: string;
  /** Hang detector — epoch-sec of last tool execution. */
  lastToolAtFile: string;
  logFile: string;
  discordChannelId: string;
  discordBotToken: string;
  discordWebhookUrl: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  dashboardPort: number;
  tmuxSession: string;
  pollIntervalSec: number;
  /** Minutes a genuine prompt may stay unanswered (no tool activity) before hung. */
  hangThresholdMin: number;
  /** Seconds after a hang restart during which the detector will not re-fire. */
  hangRestartCooldownSec: number;
  /** When true, run an in-process hang-detector self-test on startup. */
  hangSelfTest: boolean;
  /**
   * When true, the slow-hang detector may auto-restart claude-discord. Disabled
   * by default (2026-06-16): its progress signals (prompt_count growth, open
   * agent_episodes) are not yet reliable — the Stop hook never increments
   * prompt_count and episodes are never closed, so the detector false-positives
   * and self-loops. Crash / stale-heartbeat detection is unaffected.
   */
  hangDetectionEnabled: boolean;
}

/** Expand ~ in paths */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/** Parse a .env file into a key→value map */
async function parseEnvFile(filePath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      result[key] = val;
    }
  } catch {
    // File not found or unreadable — return empty
  }
  return result;
}

/** Load bot token from ~/.claude/channels/discord/.env */
async function loadDiscordToken(): Promise<string> {
  const discordEnv = path.join(os.homedir(), '.claude', 'channels', 'discord', '.env');
  const vars = await parseEnvFile(discordEnv);
  return vars['BOT_TOKEN'] ?? '';
}

/** Load the "Dashboard" webhook URL from ~/claude/agent-bus/discord_webhooks.json */
async function loadWebhookUrl(): Promise<string> {
  const cfg = path.join(os.homedir(), 'claude', 'agent-bus', 'discord_webhooks.json');
  try {
    const raw = await fs.readFile(cfg, 'utf8');
    const map = JSON.parse(raw) as Record<string, string>;
    return map['claude-code'] ?? '';
  } catch {
    return '';
  }
}

export async function loadConfig(): Promise<WatchdogConfig> {
  // Load watchdog.env if present
  const watchdogDir = expandHome(process.env['WATCHDOG_DIR'] ?? '~/.wren-watchdog');
  const watchdogEnvFile = path.join(watchdogDir, 'watchdog.env');
  const envVars = await parseEnvFile(watchdogEnvFile);

  const get = (key: string, fallback: string): string =>
    process.env[key] ?? envVars[key] ?? fallback;

  const staleThresholdSec = parseInt(get('STALE_THRESHOLD_SEC', '600'), 10);
  const canaryTimeoutSec = parseInt(get('CANARY_TIMEOUT_SEC', '300'), 10);
  const maxRestartsHour = parseInt(get('MAX_RESTARTS_HOUR', '3'), 10);
  const breakerCooldownSec = parseInt(get('BREAKER_COOLDOWN_SEC', '1800'), 10);
  const proactivePromptLimit = parseInt(get('PROACTIVE_PROMPT_LIMIT', '500'), 10);
  const dashboardPort = parseInt(get('DASHBOARD_PORT', '8766'), 10);
  const discordChannelId = get('DISCORD_CHANNEL_ID', '1012721652049657896');
  const supabaseUrl = get(
    'SUPABASE_URL',
    'https://ogqjjlbupqnvlcyrfnxi.supabase.co'
  );
  const supabaseServiceKey = get('SUPABASE_SECRET_KEY', '');
  if (!supabaseServiceKey) {
    throw new Error('SUPABASE_SECRET_KEY is required');
  }
  const tmuxSession = get('TMUX_SESSION', 'claude-discord');
  const pollIntervalSec = parseInt(get('POLL_INTERVAL_SEC', '60'), 10);
  const hangThresholdMin = parseInt(get('HANG_THRESHOLD_MIN', '20'), 10);
  const hangRestartCooldownSec = parseInt(get('HANG_RESTART_COOLDOWN_SEC', '300'), 10);
  const hangSelfTest = get('HANG_SELF_TEST', '1') !== '0';
  // Re-enabled by default 2026-06-16 after the signal redesign (file-based,
  // canary-proof). Set HANG_DETECTION_ENABLED=0 to disable auto-restart-on-hang.
  const hangDetectionEnabled = get('HANG_DETECTION_ENABLED', '1') === '1';

  // Discord token: prefer env var, fall back to ~/.claude/channels/discord/.env
  let discordBotToken = process.env['BOT_TOKEN'] ?? envVars['BOT_TOKEN'] ?? '';
  if (!discordBotToken) {
    discordBotToken = await loadDiscordToken();
  }

  // Webhook for automated alerts (posts as "Dashboard"); env override, else the
  // shared webhook map. Falls back to the bot token at send time if empty.
  let discordWebhookUrl = get('DISCORD_WEBHOOK_URL', '');
  if (!discordWebhookUrl) {
    discordWebhookUrl = await loadWebhookUrl();
  }

  return {
    staleThresholdSec,
    canaryTimeoutSec,
    maxRestartsHour,
    breakerCooldownSec,
    proactivePromptLimit,
    watchdogDir,
    heartbeatFile: path.join(watchdogDir, 'heartbeat'),
    stateFile: path.join(watchdogDir, 'state.json'),
    breakerStateFile: path.join(watchdogDir, 'breaker.json'),
    counterFile: path.join(watchdogDir, 'prompt_count'),
    lastPromptAtFile: path.join(watchdogDir, 'last_prompt_at'),
    lastResponseAtFile: path.join(watchdogDir, 'last_response_at'),
    lastToolAtFile: path.join(watchdogDir, 'last_tool_at'),
    logFile: path.join(watchdogDir, 'watchdog-ts.log'),
    discordChannelId,
    discordBotToken,
    discordWebhookUrl,
    supabaseUrl,
    supabaseServiceKey,
    dashboardPort,
    tmuxSession,
    pollIntervalSec,
    hangThresholdMin,
    hangRestartCooldownSec,
    hangSelfTest,
    hangDetectionEnabled,
  };
}
