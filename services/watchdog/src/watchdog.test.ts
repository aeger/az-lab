/**
 * watchdog.test.ts — TDD test suite (written BEFORE implementation)
 * All tests must fail initially (red phase), then pass after implementation (green phase).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─────────────────────────────────────────────────────────────────────────────
// 1. HeartbeatMonitor
// ─────────────────────────────────────────────────────────────────────────────
describe('HeartbeatMonitor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-hb-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns stale=true when heartbeat file does not exist', async () => {
    const { HeartbeatMonitor } = await import('./heartbeat.js');
    const monitor = new HeartbeatMonitor({
      heartbeatFile: path.join(tmpDir, 'heartbeat'),
      staleThresholdSec: 600,
    });
    const result = await monitor.check();
    expect(result.stale).toBe(true);
    expect(result.ageSec).toBeGreaterThan(1000);
  });

  it('returns stale=false when heartbeat is recent', async () => {
    const { HeartbeatMonitor } = await import('./heartbeat.js');
    const heartbeatFile = path.join(tmpDir, 'heartbeat');
    await fs.writeFile(heartbeatFile, String(Math.floor(Date.now() / 1000) - 30));
    const monitor = new HeartbeatMonitor({ heartbeatFile, staleThresholdSec: 600 });
    const result = await monitor.check();
    expect(result.stale).toBe(false);
    expect(result.ageSec).toBeLessThan(60);
  });

  it('returns stale=true when heartbeat timestamp is older than threshold', async () => {
    const { HeartbeatMonitor } = await import('./heartbeat.js');
    const heartbeatFile = path.join(tmpDir, 'heartbeat');
    const oldTs = Math.floor(Date.now() / 1000) - 700;
    await fs.writeFile(heartbeatFile, String(oldTs));
    const monitor = new HeartbeatMonitor({ heartbeatFile, staleThresholdSec: 600 });
    const result = await monitor.check();
    expect(result.stale).toBe(true);
    expect(result.ageSec).toBeGreaterThanOrEqual(700);
  });

  it('respects configurable stale threshold', async () => {
    const { HeartbeatMonitor } = await import('./heartbeat.js');
    const heartbeatFile = path.join(tmpDir, 'heartbeat');
    // 120 seconds old — stale at 60s threshold, fresh at 300s threshold
    await fs.writeFile(heartbeatFile, String(Math.floor(Date.now() / 1000) - 120));
    const monitorTight = new HeartbeatMonitor({ heartbeatFile, staleThresholdSec: 60 });
    const monitorLoose = new HeartbeatMonitor({ heartbeatFile, staleThresholdSec: 300 });
    expect((await monitorTight.check()).stale).toBe(true);
    expect((await monitorLoose.check()).stale).toBe(false);
  });

  it('returns ageSec as number (never null/undefined)', async () => {
    const { HeartbeatMonitor } = await import('./heartbeat.js');
    const monitor = new HeartbeatMonitor({
      heartbeatFile: path.join(tmpDir, 'missing'),
      staleThresholdSec: 600,
    });
    const result = await monitor.check();
    expect(typeof result.ageSec).toBe('number');
    expect(result.ageSec).not.toBeNaN();
  });

  it('handles corrupt heartbeat file gracefully (returns stale=true)', async () => {
    const { HeartbeatMonitor } = await import('./heartbeat.js');
    const heartbeatFile = path.join(tmpDir, 'heartbeat');
    await fs.writeFile(heartbeatFile, 'not-a-number');
    const monitor = new HeartbeatMonitor({ heartbeatFile, staleThresholdSec: 600 });
    const result = await monitor.check();
    expect(result.stale).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. CanarySender
// ─────────────────────────────────────────────────────────────────────────────
describe('CanarySender', () => {
  it('sends canary when no previous canary exists (canarySentAt is null)', async () => {
    const { CanarySender } = await import('./canary.js');
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const sender = new CanarySender({
      tmuxSession: 'claude-discord',
      canaryTimeoutSec: 300,
      execFn: exec,
    });
    const result = await sender.sendIfNeeded(null);
    expect(result.sent).toBe(true);
    expect(result.canarySentAt).toBeTypeOf('number');
    expect(exec).toHaveBeenCalledOnce();
  });

  it('skips sending canary when already sent within timeout window', async () => {
    const { CanarySender } = await import('./canary.js');
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const sender = new CanarySender({
      tmuxSession: 'claude-discord',
      canaryTimeoutSec: 300,
      execFn: exec,
    });
    const recentlySent = Math.floor(Date.now() / 1000) - 100; // 100s ago, within 300s window
    const result = await sender.sendIfNeeded(recentlySent);
    expect(result.sent).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('re-sends canary when previous canary has expired', async () => {
    const { CanarySender } = await import('./canary.js');
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const sender = new CanarySender({
      tmuxSession: 'claude-discord',
      canaryTimeoutSec: 300,
      execFn: exec,
    });
    const expiredAt = Math.floor(Date.now() / 1000) - 400; // 400s ago, past 300s window
    const result = await sender.sendIfNeeded(expiredAt);
    expect(result.sent).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
  });

  it('sends correct tmux command format with timestamp', async () => {
    const { CanarySender } = await import('./canary.js');
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const sender = new CanarySender({
      tmuxSession: 'claude-discord',
      canaryTimeoutSec: 300,
      execFn: exec,
    });
    await sender.sendIfNeeded(null);
    const calledWith = exec.mock.calls[0][0] as string;
    expect(calledWith).toMatch(/tmux send-keys -t claude-discord/);
    expect(calledWith).toMatch(/watchdog-canary-\d+/);
    expect(calledWith).toMatch(/Enter/);
  });

  it('handles tmux exec failure gracefully (does not throw)', async () => {
    const { CanarySender } = await import('./canary.js');
    const exec = vi.fn().mockRejectedValue(new Error('tmux not found'));
    const sender = new CanarySender({
      tmuxSession: 'claude-discord',
      canaryTimeoutSec: 300,
      execFn: exec,
    });
    await expect(sender.sendIfNeeded(null)).resolves.not.toThrow();
    const result = await sender.sendIfNeeded(null);
    expect(result.sent).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. CircuitBreaker
// ─────────────────────────────────────────────────────────────────────────────
describe('CircuitBreaker', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-cb-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('is open (not tripped) initially with no restarts', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    const status = await cb.getStatus();
    expect(status.tripped).toBe(false);
    expect(status.restartsInLastHour).toBe(0);
  });

  it('trips after maxRestartsHour restarts within one hour', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    await cb.recordRestart();
    await cb.recordRestart();
    await cb.recordRestart();
    const status = await cb.getStatus();
    expect(status.tripped).toBe(true);
    expect(status.restartsInLastHour).toBe(3);
  });

  it('does not trip on fewer than maxRestartsHour restarts', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    await cb.recordRestart();
    await cb.recordRestart();
    const status = await cb.getStatus();
    expect(status.tripped).toBe(false);
    expect(status.restartsInLastHour).toBe(2);
  });

  it('respects cooldown period — remains tripped during cooldown', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    // Manually write a tripped state with breaker tripped NOW
    const now = Math.floor(Date.now() / 1000);
    await fs.writeFile(stateFile, JSON.stringify({
      restarts: [now - 10, now - 20, now - 30],
      canarySentAt: null,
      lastStatus: 'critical',
      breakerTrippedAt: now - 100, // tripped 100s ago, cooldown is 1800s
    }));
    const status = await cb.getStatus();
    expect(status.tripped).toBe(true);
    expect(status.cooldownRemaining).toBeGreaterThan(0);
  });

  it('resets tripped state after cooldown expires', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    const now = Math.floor(Date.now() / 1000);
    await fs.writeFile(stateFile, JSON.stringify({
      restarts: [now - 3700, now - 3800, now - 3900], // older than 1 hour — pruned
      canarySentAt: null,
      lastStatus: 'critical',
      breakerTrippedAt: now - 2000, // tripped 2000s ago > 1800s cooldown
    }));
    const status = await cb.getStatus();
    expect(status.tripped).toBe(false);
  });

  it('prunes restarts older than one hour from count', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    const now = Math.floor(Date.now() / 1000);
    await fs.writeFile(stateFile, JSON.stringify({
      restarts: [now - 4000, now - 3700, now - 100], // first two are stale
      canarySentAt: null,
      lastStatus: 'healthy',
      breakerTrippedAt: null,
    }));
    const status = await cb.getStatus();
    expect(status.restartsInLastHour).toBe(1);
    expect(status.tripped).toBe(false);
  });

  it('allowsRestart returns false when tripped and in cooldown', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    const now = Math.floor(Date.now() / 1000);
    await fs.writeFile(stateFile, JSON.stringify({
      restarts: [now - 10, now - 20, now - 30],
      canarySentAt: null,
      lastStatus: 'critical',
      breakerTrippedAt: now - 100,
    }));
    expect(await cb.allowsRestart()).toBe(false);
  });

  it('allowsRestart returns true when not tripped', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    expect(await cb.allowsRestart()).toBe(true);
  });

  it('persists state atomically (uses tmp+rename pattern)', async () => {
    const { CircuitBreaker } = await import('./circuit-breaker.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const cb = new CircuitBreaker({ stateFile, maxRestartsHour: 3, cooldownSec: 1800 });
    await cb.recordRestart();
    // State file should exist and be valid JSON
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.restarts).toHaveLength(1);
    // tmp file should not be left behind
    await expect(fs.access(stateFile + '.tmp')).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. DiscordNotifier
// ─────────────────────────────────────────────────────────────────────────────
describe('DiscordNotifier', () => {
  it('sends a well-formed embed with no null fields', async () => {
    const { DiscordNotifier } = await import('./discord.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: '12345' }),
      headers: { get: () => null },
    });
    const notifier = new DiscordNotifier({
      botToken: 'test-token',
      channelId: '1012721652049657896',
      fetchFn: fetchMock as any,
    });
    await notifier.send('Test message', 3447003);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('channels/1012721652049657896/messages');
    const body = JSON.parse(opts.body);
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toBeDefined();
    expect(embed.title).not.toBeNull();
    expect(embed.description).toBe('Test message');
    expect(embed.color).toBe(3447003);
    // Verify no null fields in embed
    for (const [key, val] of Object.entries(embed)) {
      expect(val).not.toBeNull();
    }
  });

  it('includes Authorization header with Bot prefix', async () => {
    const { DiscordNotifier } = await import('./discord.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: '12345' }),
      headers: { get: () => null },
    });
    const notifier = new DiscordNotifier({
      botToken: 'my-secret-token',
      channelId: '1012721652049657896',
      fetchFn: fetchMock as any,
    });
    await notifier.send('Hello', 0);
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bot my-secret-token');
  });

  it('handles 429 rate limit with retry-after and does not throw', async () => {
    const { DiscordNotifier } = await import('./discord.js');
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ retry_after: 0.1 }),
          headers: { get: (h: string) => h === 'retry-after' ? '0.1' : null },
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: '12345' }),
        headers: { get: () => null },
      };
    });
    const notifier = new DiscordNotifier({
      botToken: 'test-token',
      channelId: '1012721652049657896',
      fetchFn: fetchMock as any,
    });
    await expect(notifier.send('Rate limited test', 0)).resolves.not.toThrow();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 10000);

  it('handles network failure gracefully and does not throw', async () => {
    const { DiscordNotifier } = await import('./discord.js');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const notifier = new DiscordNotifier({
      botToken: 'test-token',
      channelId: '1012721652049657896',
      fetchFn: fetchMock as any,
    });
    await expect(notifier.send('Test', 0)).resolves.not.toThrow();
  });

  it('uses default color when none provided', async () => {
    const { DiscordNotifier } = await import('./discord.js');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: '12345' }),
      headers: { get: () => null },
    });
    const notifier = new DiscordNotifier({
      botToken: 'test-token',
      channelId: '1012721652049657896',
      fetchFn: fetchMock as any,
    });
    await notifier.send('No color test');
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(typeof body.embeds[0].color).toBe('number');
    expect(body.embeds[0].color).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. WatchdogDashboard
// ─────────────────────────────────────────────────────────────────────────────
describe('WatchdogDashboard', () => {
  let server: any;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('GET /health returns 200 with valid JSON', async () => {
    const { WatchdogDashboard } = await import('./dashboard.js');
    const dashboard = new WatchdogDashboard({ port: 0 }); // port 0 = random available port
    server = await dashboard.start();
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body).toBe('object');
  });

  it('GET /health response has all required fields, none null', async () => {
    const { WatchdogDashboard } = await import('./dashboard.js');
    const dashboard = new WatchdogDashboard({ port: 0 });
    server = await dashboard.start();
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    // Required fields
    const requiredFields = ['status', 'heartbeat_age', 'last_restart', 'prompt_count', 'circuit_breaker'];
    for (const field of requiredFields) {
      expect(body).toHaveProperty(field);
      expect(body[field]).not.toBeNull();
      expect(body[field]).not.toBeUndefined();
    }
  });

  it('GET /health status field is a non-empty string', async () => {
    const { WatchdogDashboard } = await import('./dashboard.js');
    const dashboard = new WatchdogDashboard({ port: 0 });
    server = await dashboard.start();
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.status).toBe('string');
    expect((body.status as string).length).toBeGreaterThan(0);
  });

  it('GET /health circuit_breaker field is an object with tripped boolean', async () => {
    const { WatchdogDashboard } = await import('./dashboard.js');
    const dashboard = new WatchdogDashboard({ port: 0 });
    server = await dashboard.start();
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.circuit_breaker).toBe('object');
    const cb = body.circuit_breaker as Record<string, unknown>;
    expect(typeof cb.tripped).toBe('boolean');
  });

  it('GET /health returns valid JSON even when status is updated', async () => {
    const { WatchdogDashboard } = await import('./dashboard.js');
    const dashboard = new WatchdogDashboard({ port: 0 });
    server = await dashboard.start();
    const { port } = server.address();
    // Update status
    dashboard.updateStatus({
      status: 'degraded',
      heartbeat_age: 650,
      last_restart: '2026-04-12T00:00:00Z',
      prompt_count: 42,
      circuit_breaker: { tripped: false, restarts_in_last_hour: 1, cooldown_remaining: 0 },
    });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('degraded');
    expect(body.heartbeat_age).toBe(650);
    expect(body.prompt_count).toBe(42);
  });

  it('returns 404 for unknown routes', async () => {
    const { WatchdogDashboard } = await import('./dashboard.js');
    const dashboard = new WatchdogDashboard({ port: 0 });
    server = await dashboard.start();
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/unknown`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. GracefulDegradation
// ─────────────────────────────────────────────────────────────────────────────
describe('GracefulDegradation', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-gd-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('falls back to local log when Discord is unreachable', async () => {
    const { DiscordNotifier } = await import('./discord.js');
    const { LocalLogger } = await import('./logger.js');
    const logFile = path.join(tmpDir, 'watchdog.log');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const notifier = new DiscordNotifier({
      botToken: 'test-token',
      channelId: '1012721652049657896',
      fetchFn: fetchMock as any,
      fallbackLogFile: logFile,
    });
    await notifier.send('Degradation test', 0);
    // Should have written to fallback log
    const logContents = await fs.readFile(logFile, 'utf8');
    expect(logContents).toContain('Degradation test');
  });

  it('continues operating when Supabase is unreachable (no throw)', async () => {
    const { SupabaseReporter } = await import('./supabase-reporter.js');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const reporter = new SupabaseReporter({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'fake-key',
      fetchFn: fetchMock as any,
    });
    // Should not throw even when Supabase is down
    await expect(reporter.updateStatus('healthy', {})).resolves.not.toThrow();
  });

  it('logs locally when Supabase is unreachable', async () => {
    const { SupabaseReporter } = await import('./supabase-reporter.js');
    const logFile = path.join(tmpDir, 'supabase-fallback.log');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const reporter = new SupabaseReporter({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'fake-key',
      fetchFn: fetchMock as any,
      fallbackLogFile: logFile,
    });
    await reporter.updateStatus('healthy', { test: true });
    const logContents = await fs.readFile(logFile, 'utf8');
    expect(logContents).toContain('healthy');
  });

  it('StateManager uses atomic write (tmp+rename, no corrupt state on crash)', async () => {
    const { StateManager } = await import('./state.js');
    const stateFile = path.join(tmpDir, 'state.json');
    const sm = new StateManager(stateFile);
    const initial = await sm.load();
    expect(initial).toBeDefined();
    await sm.save({ ...initial, lastStatus: 'healthy' });
    // File should be valid JSON
    const raw = await fs.readFile(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.lastStatus).toBe('healthy');
    // No tmp file left behind
    await expect(fs.access(stateFile + '.tmp')).rejects.toThrow();
  });

  it('LocalLogger trims log file when over 1000 lines', async () => {
    const { LocalLogger } = await import('./logger.js');
    const logFile = path.join(tmpDir, 'test.log');
    const logger = new LocalLogger(logFile);
    // Write 1100 lines
    for (let i = 0; i < 1100; i++) {
      await logger.log(`Line ${i}`);
    }
    const contents = await fs.readFile(logFile, 'utf8');
    const lineCount = contents.trim().split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(500);
  });
});
