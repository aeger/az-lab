/**
 * heartbeat.ts — HeartbeatMonitor: reads timestamp file, determines staleness
 *
 * `~/.wren-watchdog/heartbeat` is written by hooks that fire in EVERY Claude
 * Code session on this host, not just the bridge. On 2026-09-17 Jeff SSH'd in
 * and started his own interactive session; its prompts kept the shared file
 * warm and the watchdog logged "Recovered to healthy" repeatedly while the
 * bridge sat behind a login wall answering nothing. An unrelated session must
 * not be able to vouch for the bridge.
 *
 * The hooks now also write a bridge-scoped file when (and only when) they run
 * inside the bridge session. When that file exists it is the only one that
 * counts. The shared file remains the fallback purely so the first poll after a
 * deploy — before the bridge has written its own file even once — behaves as it
 * did before rather than declaring a false outage.
 */

import { promises as fs } from 'fs';

export interface HeartbeatConfig {
  heartbeatFile: string;
  staleThresholdSec: number;
  /** Bridge-scoped heartbeat. Omit to keep the old shared-file behaviour. */
  bridgeHeartbeatFile?: string;
}

/** Which file the age was measured from — 'shared' means any session's prompt counted. */
export type HeartbeatSource = 'bridge' | 'shared' | 'none';

export interface HeartbeatResult {
  stale: boolean;
  ageSec: number;
  timestamp: number | null;
  source: HeartbeatSource;
}

export class HeartbeatMonitor {
  private readonly config: HeartbeatConfig;

  constructor(config: HeartbeatConfig) {
    this.config = config;
  }

  private async readStamp(file: string): Promise<number | null> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = parseInt(raw.trim(), 10);
      return !isNaN(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  async check(): Promise<HeartbeatResult> {
    const nowSec = Math.floor(Date.now() / 1000);

    let timestamp: number | null = null;
    let source: HeartbeatSource = 'none';

    if (this.config.bridgeHeartbeatFile) {
      timestamp = await this.readStamp(this.config.bridgeHeartbeatFile);
      if (timestamp !== null) source = 'bridge';
    }

    // Only when the bridge has never written its file: fall back to the shared
    // one. Once the bridge file exists this branch is dead for good, and a
    // stranger's session can no longer mask a dead bridge.
    if (timestamp === null) {
      timestamp = await this.readStamp(this.config.heartbeatFile);
      if (timestamp !== null) source = 'shared';
    }

    const ageSec: number =
      timestamp !== null ? Math.max(0, nowSec - timestamp) : 99999;

    const stale = ageSec >= this.config.staleThresholdSec;

    return { stale, ageSec, timestamp, source };
  }
}
