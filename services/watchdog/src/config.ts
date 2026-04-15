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
  counterFile: string;
  logFile: string;
  discordChannelId: string;
  discordBotToken: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  dashboardPort: number;
  tmuxSession: string;
  pollIntervalSec: number;
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
  const supabaseServiceKey = get(
    'SUPABASE_SERVICE_KEY',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0NTU3NiwiZXhwIjoyMDg5NjIxNTc2fQ.nxAesbiMgcogKp4rOS0VodJLI127mmMbSFMHcvRKNa0'
  );
  const tmuxSession = get('TMUX_SESSION', 'claude-discord');
  const pollIntervalSec = parseInt(get('POLL_INTERVAL_SEC', '60'), 10);

  // Discord token: prefer env var, fall back to ~/.claude/channels/discord/.env
  let discordBotToken = process.env['BOT_TOKEN'] ?? envVars['BOT_TOKEN'] ?? '';
  if (!discordBotToken) {
    discordBotToken = await loadDiscordToken();
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
    counterFile: path.join(watchdogDir, 'prompt_count'),
    logFile: path.join(watchdogDir, 'watchdog-ts.log'),
    discordChannelId,
    discordBotToken,
    supabaseUrl,
    supabaseServiceKey,
    dashboardPort,
    tmuxSession,
    pollIntervalSec,
  };
}
