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
import { ChannelHealthChecker, decideChannelAction } from './channel-health.js';
import { LoginWallDetector, assessExpiryWarning, canaryIdFor } from './login-wall.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { DiscordNotifier } from './discord.js';
import { SupabaseReporter } from './supabase-reporter.js';
import { StateManager, WatchdogState } from './state.js';
import { WatchdogDashboard } from './dashboard.js';
import { LocalLogger } from './logger.js';
import { HangDetector } from './hang-detector.js';
import { runHangSelfTest } from './hang-self-test.js';
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
    bridgeHeartbeatFile: config.bridgeHeartbeatEnabled ? config.bridgeHeartbeatFile : undefined,
  });
  const canary = new CanarySender({
    tmuxSession: config.tmuxSession,
    canaryTimeoutSec: config.canaryTimeoutSec,
  });
  const breaker = new CircuitBreaker({
    stateFile: config.breakerStateFile,
    maxRestartsHour: config.maxRestartsHour,
    cooldownSec: config.breakerCooldownSec,
  });
  const discord = new DiscordNotifier({
    botToken: config.discordBotToken,
    channelId: config.discordChannelId,
    webhookUrl: config.discordWebhookUrl,
    fallbackLogFile: config.logFile,
  });
  const supabase = new SupabaseReporter({
    supabaseUrl: config.supabaseUrl,
    serviceKey: config.supabaseServiceKey,
    fallbackLogFile: config.logFile,
  });
  const channelHealth = new ChannelHealthChecker({
    bridgeMatch: config.channelBridgeMatch,
    mcpMatch: config.channelMcpMatch,
  });
  const loginWall = new LoginWallDetector({
    tmuxSession: config.tmuxSession,
    credentialsFile: config.credentialsFile,
    paneLines: config.loginWallPaneLines,
  });
  const hangDetector = new HangDetector({
    lastPromptAtFile: config.lastPromptAtFile,
    lastResponseAtFile: config.lastResponseAtFile,
    lastToolAtFile: config.lastToolAtFile,
    hangThresholdMin: config.hangThresholdMin,
    fallbackLogFile: config.logFile,
  });

  if (config.hangSelfTest) {
    const result = runHangSelfTest(hangDetector);
    if (!result.ok) {
      await logger.log(`Hang self-test FAILED: ${result.failures.join('; ')}`);
    } else {
      await logger.log(`Hang self-test ok (${result.checks} checks)`);
    }
  }

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
      await tick(config, logger, stateMgr, heartbeat, canary, breaker, discord, supabase, dashboard, hangDetector, channelHealth, loginWall);
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
  hangDetector: HangDetector,
  channelHealth: ChannelHealthChecker,
  loginWall: LoginWallDetector,
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

  // ── Credential warn-ahead ───────────────────────────────────────────────────
  // Cheap (one file read, no pane scrape) and runs on every path: a refresh
  // token that is about to die is the one auth failure we can see coming, and
  // warning after the bridge is already walled is worth much less.
  if (config.loginWallDetectionEnabled) {
    await warnAheadOfExpiry(config, logger, stateMgr, state, discord, supabase, loginWall);
  }

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
    // A fresh heartbeat and an answering canary only prove the session is
    // alive. Neither can see whether it still has its Discord MCP server, and
    // on 2026-09-04 it did not: the canary said "alive, idle" every ten minutes
    // for eleven hours while every Discord question went unanswered and systemd
    // reported the unit healthy throughout. Check the thing they cannot.
    if (config.channelHealthEnabled) {
      const health = await channelHealth.check();
      const sinceRestartSec = state.lastRestartAt
        ? now - Math.floor(new Date(state.lastRestartAt).getTime() / 1000)
        : Infinity;
      const decision = decideChannelAction({
        healthy: health.healthy,
        channelDeafSince: state.channelDeafSince,
        nowSec: now,
        deafThresholdSec: config.channelDeafThresholdSec,
        sinceRestartSec,
        restartGraceSec: config.channelRestartGraceSec,
      });

      if (decision.action === 'act') {
        await handleDeafChannel(
          config, logger, stateMgr, state, breaker, discord, supabase, dashboard,
          breakerStatus, health, decision.deafForSec,
        );
        return;
      }

      if (decision.action === 'grace') {
        // The MCP server takes tens of seconds to attach after a bounce.
        await logger.log(
          `Channel looks deaf but within post-restart grace ` +
            `(${sinceRestartSec}s / ${config.channelRestartGraceSec}s) — ${health.reason}`,
        );
      }

      if (decision.action === 'hold') {
        // Must return: the healthy path below saves channelDeafSince: null, so
        // falling through here would reset the clock on every tick and the
        // threshold would never be reached.
        await logger.log(
          state.channelDeafSince === null
            ? `Channel may be deaf — ${health.reason}`
            : `Channel deaf for ${decision.deafForSec}s ` +
              `(threshold ${config.channelDeafThresholdSec}s) — holding`,
        );
        await stateMgr.save({ ...state, channelDeafSince: decision.deafSince, lastStatus: 'degraded' });
        await supabase
          .updateStatus('degraded', { reason: 'channel_deaf', detail: health.reason })
          .catch(() => {});
        dashboard.updateStatus({ status: 'degraded' });
        return;
      }

      if (state.channelDeafSince !== null && decision.deafSince === null) {
        await logger.log(`Channel health recovered — ${health.reason}`);
        state.channelDeafSince = null;
      }
    }

    // Heartbeat looks fresh — but a slow hang can keep heartbeats ticking via
    // Stop hooks fired by canary replies / Discord reactions while the actual
    // work loop is wedged (2026-06-16 incident). Run hang detection BEFORE
    // declaring healthy, using positive, canary-proof, file-based signals (see
    // hang-detector.ts). Gated behind hangDetectionEnabled; short-circuits this
    // branch when it fires a restart.
    const trackedState: WatchdogState = state;
    if (config.hangDetectionEnabled) {
      const hangSignals = await hangDetector.fetchSignals();
      const assessment = hangDetector.assess({ nowSec: now, signals: hangSignals });

      if (assessment.isHung) {
        // Post-restart cooldown: after a hang restart, give the restarted
        // session time to answer or emit tool activity before we re-evaluate, so
        // a still-settling restart can't be bounced again every poll.
        const sinceHangRestart =
          state.hangDetectedAt !== null ? now - state.hangDetectedAt : Infinity;
        if (sinceHangRestart < config.hangRestartCooldownSec) {
          await logger.log(
            `Hang condition persists but within post-restart cooldown ` +
              `(${sinceHangRestart}s / ${config.hangRestartCooldownSec}s) — not restarting`,
          );
          return;
        }
        await handleHang(
          config, logger, stateMgr, trackedState, breaker, discord, supabase, dashboard,
          breakerStatus, assessment.reasons, hangSignals, promptCount, hbResult.ageSec,
        );
        return;
      }
    }

    const wasUnhealthy = state.lastStatus !== 'healthy';

    if (wasUnhealthy) {
      // Name the source: a 'shared' recovery is only as trustworthy as the
      // assumption that no other Claude session on the host wrote that file.
      await logger.log(
        `Recovered to healthy (was: ${state.lastStatus}, age: ${hbResult.ageSec}s, ` +
          `prompts: ${promptCount}, heartbeat source: ${hbResult.source})`,
      );
      await supabase.updateStatus('healthy', { prompt_count: promptCount, recovered_from: state.lastStatus });
      if (state.lastStatus === 'restarting' || state.lastStatus === 'critical' || state.lastStatus === 'hung') {
        await discord.send(`Wren recovered and responding (prompts: ${promptCount})`, 3066993).catch(() => {});
      }
    } else {
      await supabase.updateStatus('healthy', { prompt_count: promptCount });
    }

    if (state.authWallSince !== null) {
      await logger.log('Login wall cleared — bridge is answering again');
    }
    await stateMgr.save({
      ...trackedState,
      lastStatus: 'healthy',
      canarySentAt: null,
      hangDetectedAt: null,
      channelDeafSince: null,
      authWallSince: null,
      authAlertedAt: null,
    });
    dashboard.updateStatus({ status: 'healthy' });

    // Proactive overnight restart
    const hour = new Date().getHours();
    if (promptCount > config.proactivePromptLimit && hour >= 3 && hour <= 5) {
      await logger.log(`Proactive restart: ${promptCount} prompts, overnight window`);
      await discord.send(`Proactive overnight restart — ${promptCount} prompts, resetting context.`, 3447003).catch(() => {});
      await supabase.updateStatus('restarting', { reason: 'proactive', prompt_count: promptCount });
      await writeCounter(config.counterFile, 0);
      await exec('systemctl --user restart claude-discord.service').catch(() => {});
      await stateMgr.save({ ...trackedState, lastStatus: 'restarting', canarySentAt: null });
    }

    return;
  }

  // ── STALE path ──────────────────────────────────────────────────────────────
  await logger.log(
    `Heartbeat stale: ${hbResult.ageSec}s (threshold: ${config.staleThresholdSec}s, ` +
      `source: ${hbResult.source})`,
  );

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

  // ── LOGIN WALL check ────────────────────────────────────────────────────────
  // An unanswered canary and a canary answered by `Please run /login` look
  // identical from here: neither runs a model turn, so neither fires the Stop
  // hook the response detector watches. Ask the pane which one this is BEFORE
  // calling it unresponsive — restarting an auth failure just burns breaker
  // slots (2026-09-17: five restarts, three trips, zero effect).
  if (config.loginWallDetectionEnabled) {
    const assessment = await loginWall.check(canaryIdFor(state.canarySentAt));
    if (assessment.wall) {
      await handleLoginWall(config, logger, stateMgr, state, discord, supabase, dashboard, assessment, canaryAge);
      return;
    }
    if (assessment.evidence.statusLineMarker !== null) {
      // Worth a line: this is the shape a stale status line takes, and it is
      // the most likely reason a real wall would be missed.
      await logger.log(`Login-wall check passed — ${assessment.reason}`);
    }
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

/**
 * Login-wall handler. The bridge is up, tmux is up, the pane answers — but the
 * answer is `Please run /login`, so no work can happen and no restart will help.
 * This path deliberately does THREE things the restart paths do not:
 *
 *   - it never calls systemctl restart,
 *   - it never calls breaker.recordRestart(), so an auth outage cannot eat the
 *     hourly restart budget the way it did on 2026-09-17, and
 *   - it clears canarySentAt so the next tick sends a fresh canary. The pane
 *     evidence is only as current as the last canary, so without this the
 *     detector would keep re-reading one stale reply and never notice Jeff
 *     fixing it.
 *
 * Reasoning goes to agent_activity BEFORE the page, per wren_constitution
 * principle 2.
 */
async function handleLoginWall(
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: LocalLogger,
  stateMgr: StateManager,
  state: WatchdogState,
  discord: DiscordNotifier,
  supabase: SupabaseReporter,
  dashboard: WatchdogDashboard,
  assessment: import('./login-wall.js').LoginWallAssessment,
  canaryAgeSec: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const wallSince = state.authWallSince ?? now;
  const wallForSec = now - wallSince;

  await logger.log(
    `LOGIN WALL (${assessment.trigger}) — ${assessment.reason}; ` +
      `not restarting (walled for ${wallForSec}s)`,
  );

  const metadata = {
    trigger: assessment.trigger,
    detail: assessment.reason,
    evidence: assessment.evidence,
    canary_age_sec: canaryAgeSec,
    walled_for_sec: wallForSec,
    tmux_session: config.tmuxSession,
    restart_suppressed: true,
  };

  await supabase.logActivity(
    'login_wall',
    `Bridge is behind a Claude Code login wall, not hung: ${assessment.reason}. ` +
      `Withholding the restart — only /login clears this.`,
    metadata,
  ).catch(() => {});

  const shouldPage =
    state.authWallSince === null ||
    state.authAlertedAt === null ||
    now - state.authAlertedAt >= config.authRealertSec;

  if (shouldPage) {
    await supabase.emitSentinelNotification(
      'critical',
      'Discord bridge needs /login',
      `The bridge is running and answering the pane, but every turn hits a Claude Code ` +
        `login wall, so no work can happen.\n\n${assessment.reason}\n\n` +
        `A restart cannot fix this — run /login in the bridge session.`,
      `login-wall:${config.tmuxSession}:${wallSince}`,
      metadata,
      'agent_auth',
    ).catch(() => {});

    await discord.send(
      `AUTH: the Discord bridge is behind a Claude Code login wall — **not** hung, and ` +
        `**not** restarting (a restart cannot clear an auth failure).\n` +
        `${assessment.reason}\n` +
        `Run \`/login\` in the bridge session:\n` +
        `\`\`\`\nssh almty1@192.168.1.181\ntmux attach -t ${config.tmuxSession}\n/login\n\`\`\``,
      15158332,
    ).catch(() => {});
  }

  await stateMgr.save({
    ...state,
    // Cleared so the next tick re-canaries and the pane evidence stays current.
    canarySentAt: null,
    lastStatus: 'auth_blocked',
    authWallSince: wallSince,
    authAlertedAt: shouldPage ? now : state.authAlertedAt,
  });
  await supabase.updateStatus('auth_blocked', metadata).catch(() => {});
  dashboard.updateStatus({ status: 'auth_blocked' });
}

/**
 * The cheap half of the auth story: read the credential file and page ahead of
 * a refresh-token expiry instead of discovering it from a restart loop. Keyed
 * on the refresh token only — an expired ACCESS token is routine (Claude Code
 * refreshes it on the next request), so alerting on that would be noise.
 * Deduped by the expiry timestamp, so one token warns once.
 */
async function warnAheadOfExpiry(
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: LocalLogger,
  stateMgr: StateManager,
  state: WatchdogState,
  discord: DiscordNotifier,
  supabase: SupabaseReporter,
  loginWall: LoginWallDetector,
): Promise<void> {
  const creds = await loginWall.readCredentials();
  const warning = assessExpiryWarning(
    creds,
    config.authExpiryWarnSec,
    state.authWarnedForRefreshExpiresAt,
  );
  if (!warning.warn) return;

  await logger.log(`Auth expiry warning — ${warning.reason}`);

  const metadata = {
    reason: warning.reason,
    credential_verdict: creds.verdict,
    access_expires_in_sec: creds.accessExpiresInSec,
    refresh_expires_in_sec: creds.refreshExpiresInSec,
    refresh_token_expires_at: creds.refreshTokenExpiresAt,
    credentials_file: config.credentialsFile,
  };

  await supabase.logActivity('auth_expiry_warning', warning.reason, metadata).catch(() => {});
  await supabase.emitSentinelNotification(
    'warning',
    'Claude Code re-auth needed soon',
    `${warning.reason}\n\nRun /login in the bridge session before it lapses — once it does, ` +
      `the bridge answers every prompt with a login wall and only a human can clear it.`,
    `auth-expiry:${creds.refreshTokenExpiresAt}`,
    metadata,
    'agent_auth',
  ).catch(() => {});
  await discord.send(`Heads up: ${warning.reason}`, 16776960).catch(() => {});

  // Persisted immediately — several tick paths return without saving, and an
  // unsaved dedupe key would re-page on every poll.
  state.authWarnedForRefreshExpiresAt = warning.refreshTokenExpiresAt;
  await stateMgr.save({ ...state }).catch(() => {});
}

/**
 * Deaf-channel handler. Runs when the session is alive and answering but has
 * lost the MCP server that carries Discord traffic — it can neither hear a
 * message nor reply to one, while every other signal reads healthy. Restarting
 * the unit reattaches the server; that is the fix that worked by hand on
 * 2026-09-04. Breaker-gated like every other restart path.
 */
async function handleDeafChannel(
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: LocalLogger,
  stateMgr: StateManager,
  state: WatchdogState,
  breaker: CircuitBreaker,
  discord: DiscordNotifier,
  supabase: SupabaseReporter,
  dashboard: WatchdogDashboard,
  breakerStatus: { tripped: boolean; restartsInLastHour: number; cooldownRemaining: number },
  health: import('./channel-health.js').ChannelHealthResult,
  deafForSec: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await logger.log(`CHANNEL DEAF (${deafForSec}s) — ${health.reason}`);

  const metadata = {
    detail: health.reason,
    bridge_pid: health.bridgePid,
    mcp_pids: health.mcpPids,
    deaf_for_sec: deafForSec,
  };

  await supabase.logActivity(
    'channel_deaf',
    `Discord bridge alive but has no MCP server attached: ${health.reason}`,
    metadata,
  ).catch(() => {});

  await supabase.emitSentinelNotification(
    'critical',
    'Discord bridge is deaf',
    `The bridge session is responsive but cannot send or receive on Discord.\n\n${health.reason}`,
    `channel-deaf:${health.bridgePid ?? 'none'}:${now}`,
    metadata,
    'channel_deaf',
  ).catch(() => {});

  if (breakerStatus.tripped || !(await breaker.allowsRestart())) {
    await logger.log('Channel deaf but circuit breaker tripped — paging without restart');
    await stateMgr.save({ ...state, lastStatus: 'critical', channelDeafSince: null });
    await supabase.updateStatus('critical', { ...metadata, breaker_tripped: true }).catch(() => {});
    dashboard.updateStatus({ status: 'critical' });
    await discord.send(
      `CRITICAL: Discord bridge is deaf (no MCP server) and the breaker is tripped.\n` +
        `It is answering canaries but cannot see your messages.\n` +
        `\`\`\`\ntouch ~/.wren-watchdog/reset\nsystemctl --user restart claude-discord.service\n\`\`\``,
      15158332,
    ).catch(() => {});
    return;
  }

  const tier = breakerStatus.restartsInLastHour + 1;
  await breaker.recordRestart();
  const restartAt = new Date().toISOString();
  await stateMgr.save({
    ...state,
    canarySentAt: null,
    channelDeafSince: null,
    lastStatus: 'restarting',
    lastRestartAt: restartAt,
  });
  await supabase.updateStatus('restarting', { reason: 'channel_deaf', tier, ...metadata }).catch(() => {});
  await supabase.updateLastRestart(restartAt, tier).catch(() => {});

  await exec('systemctl --user restart claude-discord.service').catch(async err => {
    await logger.log(`Deaf-channel restart failed: ${err}`);
  });

  dashboard.updateStatus({ status: 'restarting', last_restart: restartAt });
  await discord.send(
    `Discord bridge had lost its MCP server — auto-restarted (tier ${tier}). ` +
      `It was responsive but deaf for ${deafForSec}s.`,
    16744448,
  ).catch(() => {});
  await logger.log('Deaf-channel restart issued');
}

/**
 * Slow-hang handler. Runs when the heartbeat looks fresh but the hang detector
 * says no work is making progress. Mirrors the unresponsive-restart path but
 * keyed off a different signal — and writes a reasoning row to agent_activity
 * BEFORE issuing the restart, per wren_constitution principle 2.
 */
async function handleHang(
  config: Awaited<ReturnType<typeof loadConfig>>,
  logger: LocalLogger,
  stateMgr: StateManager,
  trackedState: WatchdogState,
  breaker: CircuitBreaker,
  discord: DiscordNotifier,
  supabase: SupabaseReporter,
  dashboard: WatchdogDashboard,
  breakerStatus: { tripped: boolean; restartsInLastHour: number; cooldownRemaining: number },
  reasons: string[],
  signals: import('./hang-detector.js').HangSignals,
  promptCount: number,
  heartbeatAgeSec: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const reasonSummary = reasons.join(' | ');
  await logger.log(`HANG DETECTED — ${reasonSummary}`);

  const hangMetadata = {
    reasons,
    prompt_count: promptCount,
    heartbeat_age_sec: heartbeatAgeSec,
    last_prompt_at: signals.lastPromptAt,
    last_response_at: signals.lastResponseAt,
    last_tool_at: signals.lastToolAt,
    hang_threshold_min: config.hangThresholdMin,
  };

  // Reasoning row — written BEFORE any restart so the trail survives even if
  // the restart itself fails or wedges.
  await supabase.logActivity(
    'hang_detected',
    `Slow hang detected by watchdog: ${reasonSummary}`,
    hangMetadata,
  );

  // Sentinel notification — drives the dashboard alert ribbon.
  await supabase.emitSentinelNotification(
    'critical',
    'Wren slow hang detected',
    `Wren heartbeat is fresh but the work loop is wedged.\n\n${reasonSummary}`,
    `hang:${signals.lastPromptAt ?? 'no-prompt'}:${now}`,
    hangMetadata,
  );

  // Breaker check — if already tripped, page and bail. We do NOT auto-restart
  // through a tripped breaker; the manual-reset path is the escape hatch.
  if (breakerStatus.tripped) {
    await logger.log(`Hang detected but circuit breaker tripped — paging without restart`);
    await stateMgr.save({
      ...trackedState,
      lastStatus: 'hung',
      hangDetectedAt: now,
    });
    await supabase.updateStatus('hung', {
      ...hangMetadata,
      breaker_tripped: true,
      cooldown_remaining: breakerStatus.cooldownRemaining,
    });
    dashboard.updateStatus({ status: 'critical' });
    await discord.send(
      `CRITICAL: Wren slow-hang detected but breaker is tripped (cooldown ${breakerStatus.cooldownRemaining}s).\n` +
        `Manual intervention needed: \`touch ~/.wren-watchdog/reset && systemctl --user restart claude-discord.service\`\n` +
        `Reasons: ${reasonSummary}`,
      15158332,
    ).catch(() => {});
    return;
  }

  const canRestart = await breaker.allowsRestart();
  if (!canRestart) {
    await logger.log('Hang detected but breaker tripped on this restart attempt');
    await stateMgr.save({
      ...trackedState,
      lastStatus: 'hung',
      hangDetectedAt: now,
    });
    await supabase.updateStatus('hung', { ...hangMetadata, breaker_tripped: true });
    dashboard.updateStatus({ status: 'critical' });
    return;
  }

  const tier = breakerStatus.restartsInLastHour + 1;
  await logger.log(`Restarting claude-discord on hang (tier ${tier})`);
  await breaker.recordRestart();
  const restartAt = new Date().toISOString();

  await stateMgr.save({
    ...trackedState,
    canarySentAt: null,
    lastStatus: 'restarting',
    lastRestartAt: restartAt,
    hangDetectedAt: now,
  });
  await writeCounter(config.counterFile, 0);
  await supabase.updateStatus('restarting', {
    reason: 'slow_hang',
    tier,
    ...hangMetadata,
  });
  await supabase.updateLastRestart(restartAt, tier);

  await exec('systemctl --user restart claude-discord.service').catch(async (err) => {
    await logger.log(`Hang restart failed: ${err}`);
  });

  dashboard.updateStatus({ status: 'restarting', last_restart: restartAt });

  const color = tier === 1 ? 15105570 : tier === 2 ? 16744448 : 15158332;
  await discord.send(
    `Wren slow-hang restart #${tier} — heartbeat looked fresh but no work progressed.\n` +
      `Reasons: ${reasonSummary}`,
    color,
  ).catch(() => {});
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
