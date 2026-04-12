/**
 * circuit-breaker.ts — CircuitBreaker with persistent state via atomic JSON file
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export interface CircuitBreakerConfig {
  stateFile: string;
  maxRestartsHour: number;
  cooldownSec: number;
}

export interface CircuitBreakerStatus {
  tripped: boolean;
  restartsInLastHour: number;
  cooldownRemaining: number;
  breakerTrippedAt: number | null;
}

interface RawState {
  restarts: number[];
  canarySentAt: number | null;
  lastStatus: string;
  breakerTrippedAt: number | null;
  lastRestartAt?: string | null;
  promptCount?: number;
}

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  private async readState(): Promise<RawState> {
    try {
      const raw = await fs.readFile(this.config.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<RawState>;
      return {
        restarts: Array.isArray(parsed.restarts) ? parsed.restarts : [],
        canarySentAt: parsed.canarySentAt ?? (parsed as any).canary_sent_at ?? null,
        lastStatus: parsed.lastStatus ?? (parsed as any).last_status ?? 'unknown',
        breakerTrippedAt: parsed.breakerTrippedAt ?? (parsed as any).breaker_tripped_at ?? null,
        lastRestartAt: parsed.lastRestartAt ?? null,
        promptCount: parsed.promptCount ?? 0,
      };
    } catch {
      return {
        restarts: [],
        canarySentAt: null,
        lastStatus: 'unknown',
        breakerTrippedAt: null,
        lastRestartAt: null,
        promptCount: 0,
      };
    }
  }

  private async writeState(state: RawState): Promise<void> {
    const tmp = this.config.stateFile + '.tmp';
    try {
      await fs.mkdir(path.dirname(this.config.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fs.rename(tmp, this.config.stateFile);
    } catch (err) {
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw err;
    }
  }

  async getStatus(): Promise<CircuitBreakerStatus> {
    const nowSec = Math.floor(Date.now() / 1000);
    const state = await this.readState();

    // Prune restarts older than 1 hour
    const recentRestarts = state.restarts.filter(r => r > nowSec - 3600);

    let tripped = false;
    let cooldownRemaining = 0;

    if (state.breakerTrippedAt !== null) {
      const breakerAge = nowSec - state.breakerTrippedAt;
      if (breakerAge < this.config.cooldownSec) {
        // Still in cooldown
        tripped = true;
        cooldownRemaining = this.config.cooldownSec - breakerAge;
      }
      // If cooldown has expired, breaker resets — tripped stays false
    }

    // If not in explicit cooldown, check current restart count
    if (!tripped && recentRestarts.length >= this.config.maxRestartsHour) {
      tripped = true;
    }

    return {
      tripped,
      restartsInLastHour: recentRestarts.length,
      cooldownRemaining: Math.max(0, cooldownRemaining),
      breakerTrippedAt: state.breakerTrippedAt,
    };
  }

  async allowsRestart(): Promise<boolean> {
    const status = await this.getStatus();
    return !status.tripped;
  }

  async recordRestart(): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const state = await this.readState();

    // Prune stale restarts and add this one
    const recentRestarts = state.restarts.filter(r => r > nowSec - 3600);
    recentRestarts.push(nowSec);

    // Trip the breaker if we've hit the limit
    let breakerTrippedAt = state.breakerTrippedAt;
    if (recentRestarts.length >= this.config.maxRestartsHour) {
      breakerTrippedAt = nowSec;
    }

    await this.writeState({
      ...state,
      restarts: recentRestarts,
      breakerTrippedAt,
      lastRestartAt: new Date().toISOString(),
    });
  }

  async reset(): Promise<void> {
    const state = await this.readState();
    await this.writeState({
      ...state,
      restarts: [],
      canarySentAt: null,
      lastStatus: 'healthy',
      breakerTrippedAt: null,
    });
  }
}
