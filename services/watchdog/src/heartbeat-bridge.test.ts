/**
 * heartbeat-bridge.test.ts — the shared heartbeat file must not let an
 * unrelated Claude session vouch for the bridge (2026-09-17).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HeartbeatMonitor } from './heartbeat.js';

const nowSec = () => Math.floor(Date.now() / 1000);

describe('HeartbeatMonitor — bridge-scoped heartbeat', () => {
  let tmpDir: string;
  let shared: string;
  let bridge: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-hb-bridge-'));
    shared = path.join(tmpDir, 'heartbeat');
    bridge = path.join(tmpDir, 'heartbeat.bridge');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prefers the bridge file when it exists', async () => {
    await fs.writeFile(shared, String(nowSec() - 5));
    await fs.writeFile(bridge, String(nowSec() - 120));
    const m = new HeartbeatMonitor({
      heartbeatFile: shared,
      bridgeHeartbeatFile: bridge,
      staleThresholdSec: 600,
    });
    const r = await m.check();
    expect(r.source).toBe('bridge');
    expect(r.ageSec).toBeGreaterThanOrEqual(120);
  });

  it("does not let Jeff's own session mask a dead bridge", async () => {
    // The exact 2026-09-17 shape: an interactive session on pts/1 kept the
    // shared file warm while the bridge had not answered in 20 minutes.
    await fs.writeFile(shared, String(nowSec()));
    await fs.writeFile(bridge, String(nowSec() - 1200));
    const m = new HeartbeatMonitor({
      heartbeatFile: shared,
      bridgeHeartbeatFile: bridge,
      staleThresholdSec: 600,
    });
    const r = await m.check();
    expect(r.stale).toBe(true);
    expect(r.source).toBe('bridge');
  });

  it('falls back to the shared file only until the bridge writes its own', async () => {
    await fs.writeFile(shared, String(nowSec() - 30));
    const m = new HeartbeatMonitor({
      heartbeatFile: shared,
      bridgeHeartbeatFile: bridge, // not created yet — first poll after deploy
      staleThresholdSec: 600,
    });
    const r = await m.check();
    expect(r.source).toBe('shared');
    expect(r.stale).toBe(false);
  });

  it('ignores a corrupt bridge file rather than reading it as fresh', async () => {
    await fs.writeFile(shared, String(nowSec() - 30));
    await fs.writeFile(bridge, 'not-a-number');
    const m = new HeartbeatMonitor({
      heartbeatFile: shared,
      bridgeHeartbeatFile: bridge,
      staleThresholdSec: 600,
    });
    const r = await m.check();
    expect(r.source).toBe('shared');
  });

  it('reports source=none and maximal age when neither file exists', async () => {
    const m = new HeartbeatMonitor({
      heartbeatFile: shared,
      bridgeHeartbeatFile: bridge,
      staleThresholdSec: 600,
    });
    const r = await m.check();
    expect(r.source).toBe('none');
    expect(r.stale).toBe(true);
    expect(r.timestamp).toBeNull();
  });

  it('behaves exactly as before when no bridge file is configured', async () => {
    await fs.writeFile(shared, String(nowSec() - 10));
    const m = new HeartbeatMonitor({ heartbeatFile: shared, staleThresholdSec: 600 });
    const r = await m.check();
    expect(r.source).toBe('shared');
    expect(r.stale).toBe(false);
  });
});
