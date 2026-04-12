/**
 * index.ts — Wren Watchdog main loop
 *
 * Runs every POLL_INTERVAL_SEC (default 60s).
 * Never crashes — all subsystem errors are caught and logged locally.
 *
 * Flow:
 *   1. Check for manual reset file
 *   2. Read heartbeat age
 *   3. If healthy → update Supabase, check proactive overnight restart
 *   4. If stale → send canary (if not already sent)
 *   5. If canary expired → check circuit breaker, maybe restart
 */

import { loadConfig } from './config.js';
import { HeartbeatMonitor } from './heartbeat.js';
import { CanarySender } from './canary.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { DiscordNotifier } from './discord.js';
import { SupabaseReporter } from './supabase-reporter.js';
import { StateManager } from './state.js';
import { WatchdogDashboard } from './dashboard.js';
import { LocalLogger } from './logger.js';
import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import * as path from 'path';

const exec = promisify(execCallback);

async function main() {
  const config = await loadConfig();

  const logger = new LocalLogger(config.logFile);
  const stateMgr = new StateManager(config.stateFile);
  const heartbeat = new HeartbeatMonitor({
    heartbeatFile: config.heartbeatFile,
    staleThresholdSec: config.staleThresholdSec,
  });
  const canary = new CanarySender({
    tmuxSession: config.tmuxSession,
    canaryTimeoutSec: config.canaryTimeoutSec,
  });
  const breaker = new CircuitBreaker({
    stateFile: config.stateFile,
    maxRestartsHour: config.maxRestartsHour,
    cooldownSec: config.breakerCooldownSec,
  });
  const discord = new DiscordNotifier({
    botToken: config.discordBotToken,
    channelId: config.discordChannelId,
    fallbackLogFile: config.logFile,
  });
  const supabase = new SupabaseReporter({
    supabaseUrl: config.supabaseUrl,
    serviceKey: config.supabaseServiceKey,
    fallbackLogFile: config.logFile,
  });

  // Start dashboard HTTP server
  const dashboard = new WatchdogDashboard({ port: config.dashboardPort });
  const server = await dashboard.start().catch((err) => {
    logger.log(`Dashboard failed to start: ${err}`).catch(() => {});
    return null;
  });
  if (server) {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.dashboardPort;
    await logger.log(`Dashboard listening on :${port}`);
  }

  await logger.log('Wren Watchdog (TypeScript) starting');

  // Main poll loop
  const poll = async () => {
    try {
      await tick(config, logger, stateMgr, heartbeat, canary, breaker, discord, supabase, dashboard);
    } catch (err) {
      await logger.log(`Unhandled error in tick: ${err}`).catch(() => {});
    }
    setTimeout(poll, config.pollIntervalSec * 1000);
  };

  // Run first tick immediately
  await poll();
}

async function tick(
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: LocalLogger,
  stateMgr: StateManager,
  heartbeat: HeartbeatMonitor,
  canary: CanarySender,
  breaker: CircuitBreaker,
  discord: DiscordNotifier,
  supabase: SupabaseReporter,
  dashboard: WatchdogDashboard,
) {
  const now = Math.floor(Date.now() / 1000);

  // ── Manual reset ────────────────────────────────────────────────────────────
  const resetFile = path.join(config.watchdogDir, 'reset');
  try {
    await fs.access(resetFile);
    await logger.log('Manual reset detected');
    await fs.unlink(resetFile);
    await breaker.reset();
    const state = await stateMgr.load();
    await stateMgr.save({ ...state, canarySentAt: null, lastStatus: 'healthy' });
    await supabase.updateStatus('healthy', {}).catch(() => {});
    await discord.send('Watchdog manually reset. Circuit breaker cleared.', 3066993).catch(() => {});
    return;
  } catch {
    // No reset file — continue
  }

  // ── Read state & heartbeat ───────────────────────────────────────────────────
  const state = await stateMgr.load();
  const hbResult = await heartbeat.check();
  const promptCount = await readCounter(config.counterFile);

  // ── Update dashboard ────────────────────────────────────────────────────────
  const breakerStatus = await breaker.getStatus();
  dashboard.updateStatus({
    status: state.lastStatus || 'unknown',
    heartbeat_age: hbResult.ageSec,
    last_restart: state.lastRestartAt || 'never',
    prompt_count: promptCount,
    circuit_breaker: {
      tripped: breakerStatus.tripped,
      restarts_in_last_hour: breakerStatus.restartsInLastHour,
      cooldown_remaining: breakerStatus.cooldownRemaining,
    },
  });

  // ── HEALTHY path ────────────────────────────────────────────────────────────
  if (!hbResult.stale) {
    const wasUnhealthy = state.lastStatus !== 'healthy';

    if (wasUnhealthy) {
      await logger.log(`Recovered to healthy (was: ${state.lastStatus}, age: ${hbResult.ageSec}s, prompts: ${promptCount})`);
      await supabase.updateStatus('healthy', { prompt_count: promptCount, recovered_from: state.lastStatus });
      if (state.lastStatus === 'restarting' || state.lastStatus === 'critical') {
        await discord.send(`Wren recovered and responding (prompts: ${promptCount})`, 3066993).catch(() => {});
      }
    } else {
      await supabase.updateStatus('healthy', { prompt_count: promptCount });
    }

    await stateMgr.save({ ...state, lastStatus: 'healthy', canarySentAt: null });
    dashboard.updateStatus({ status: 'healthy' });

    // Proactive overnight restart
    const hour = new Date().getHours();
    if (promptCount > config.proactivePromptLimit && hour >= 3 && hour <= 5) {
      await logger.log(`Proactive restart: ${promptCount} prompts, overnight window`);
      await discord.send(`Proactive overnight restart — ${promptCount} prompts, resetting context.`, 3447003).catch(() => {});
      await supabase.updateStatus('restarting', { reason: 'proactive', prompt_count: promptCount });
      await writeCounter(config.counterFile, 0);
      await exec('systemctl --user restart claude-discord.service').catch(() => {});
      await stateMgr.save({ ...state, lastStatus: 'restarting', canarySentAt: null });
    }

    return;
  }

  // ── STALE path ──────────────────────────────────────────────────────────────
  await logger.log(`Heartbeat stale: ${hbResult.ageSec}s (threshold: ${config.staleThresholdSec}s)`);

  // Count recent journal errors
  const errorCount = await countJournalErrors();

  // Send canary if not already sent or if expired
  if (state.canarySentAt === null) {
    await logger.log('Sending canary to test LLM responsiveness');
    const result = await canary.sendIfNeeded(null);
    if (result.sent) {
      await stateMgr.save({ ...state, canarySentAt: result.canarySentAt, lastStatus: 'degraded' });
      await supabase.updateStatus('degraded', { heartbeat_age: hbResult.ageSec, journal_errors: errorCount });
      dashboard.updateStatus({ status: 'degraded' });
    }
    return;
  }

  // Wait for canary response
  const canaryAge = now - state.canarySentAt;
  if (canaryAge < config.canaryTimeoutSec) {
    await logger.log(`Waiting for canary (${canaryAge}s / ${config.canaryTimeoutSec}s)`);
    return;
  }

  // ── UNRESPONSIVE path ────────────────────────────────────────────────────────
  await logger.log(`Canary timed out after ${canaryAge}s — Wren is unresponsive`);

  // Check circuit breaker
  if (!breakerStatus.tripped) {
    // Breaker status was read above — but check if cooldown just expired
  }

  if (breakerStatus.tripped) {
    await logger.log(`Circuit breaker active (cooldown remaining: ${breakerStatus.cooldownRemaining}s)`);
    await supabase.updateStatus('critical', {
      reason: 'breaker_active',
      cooldown_remaining: breakerStatus.cooldownRemaining,
    });
    dashboard.updateStatus({ status: 'critical' });
    return;
  }

  // Check if we can restart
  const canRestart = await breaker.allowsRestart();

  if (!canRestart) {
    // Breaker just tripped — notify
    await logger.log(`CIRCUIT BREAKER TRIPPED: ${breakerStatus.restartsInLastHour} restarts in last hour`);
    await stateMgr.save({ ...state, lastStatus: 'critical', canarySentAt: null });
    await supabase.updateStatus('critical', {
      reason: 'breaker_tripped',
      restarts_hour: breakerStatus.restartsInLastHour,
    });
    dashboard.updateStatus({ status: 'critical' });
    await discord.send(
      `CRITICAL: Wren unresponsive — circuit breaker tripped after ${breakerStatus.restartsInLastHour} restarts/hr. Manual intervention needed.\n\`\`\`\nssh almty1@192.168.1.181\nsystemctl --user restart claude-discord.service\ntouch ~/.wren-watchdog/reset\n\`\`\``,
      15158332
    ).catch(() => {});
    return;
  }

  // ── RESTART ────────────────────────────────────────────────────────────────
  const tier = breakerStatus.restartsInLastHour + 1;
  await logger.log(`Restarting claude-discord (tier ${tier})`);

  await breaker.recordRestart();
  const restartAt = new Date().toISOString();
  await stateMgr.save({
    ...state,
    canarySentAt: null,
    lastStatus: 'restarting',
    lastRestartAt: restartAt,
  });
  await writeCounter(config.counterFile, 0);
  await supabase.updateStatus('restarting', { tier, restart_count: tier, journal_errors: errorCount });
  await supabase.updateLastRestart(restartAt, tier);

  await exec('systemctl --user restart claude-discord.service').catch((err) => {
    logger.log(`Restart failed: ${err}`).catch(() => {});
  });

  dashboard.updateStatus({ status: 'restarting', last_restart: restartAt });

  const color = tier === 1 ? 16776960 : tier === 2 ? 16744448 : 15158332;
  const msg = tier === 1
    ? `Wren was unresponsive — auto-restarted (tier 1). Monitoring recovery.`
    : tier === 2
    ? `Wren unresponsive again — restart #${tier}. Possible underlying issue.`
    : `Wren restart #${tier} — approaching breaker limit (${config.maxRestartsHour}/hr).`;

  await discord.send(msg, color).catch(() => {});
  await logger.log('Restart issued');
}

async function readCounter(counterFile: string): Promise<number> {
  try {
    const raw = await fs.readFile(counterFile, 'utf8');
    const n = parseInt(raw.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

async function writeCounter(counterFile: string, value: number): Promise<void> {
  try {
    await fs.writeFile(counterFile, String(value), 'utf8');
  } catch {
    // Swallow
  }
}

async function countJournalErrors(): Promise<number> {
  try {
    const { stdout } = await exec(
      'journalctl --user -u claude-discord.service --since "5 min ago" --no-pager 2>/dev/null | grep -ciE "429|overloaded|context_length|rate_limit|panic" || echo 0'
    );
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

main().catch((err) => {
  console.error('Fatal error in watchdog main:', err);
  process.exit(1);
});
