/**
 * heartbeat.ts — HeartbeatMonitor: reads timestamp file, determines staleness
 */

import { promises as fs } from 'fs';

export interface HeartbeatConfig {
  heartbeatFile: string;
  staleThresholdSec: number;
}

export interface HeartbeatResult {
  stale: boolean;
  ageSec: number;
  timestamp: number | null;
}

export class HeartbeatMonitor {
  private readonly config: HeartbeatConfig;

  constructor(config: HeartbeatConfig) {
    this.config = config;
  }

  async check(): Promise<HeartbeatResult> {
    const nowSec = Math.floor(Date.now() / 1000);

    let timestamp: number | null = null;

    try {
      const raw = await fs.readFile(this.config.heartbeatFile, 'utf8');
      const parsed = parseInt(raw.trim(), 10);
      if (!isNaN(parsed) && parsed > 0) {
        timestamp = parsed;
      }
    } catch {
      // File missing or unreadable — treat as maximally stale
    }

    const ageSec: number =
      timestamp !== null ? Math.max(0, nowSec - timestamp) : 99999;

    const stale = ageSec >= this.config.staleThresholdSec;

    return { stale, ageSec, timestamp };
  }
}
