/**
 * state.ts — Atomic JSON state file manager (write to .tmp, then rename)
 */

import { promises as fs } from 'fs';
import * as path from 'path';

export interface WatchdogState {
  restarts: number[];
  canarySentAt: number | null;
  lastStatus: string;
  breakerTrippedAt: number | null;
  lastRestartAt: string | null;
  promptCount: number;
}

const DEFAULT_STATE: WatchdogState = {
  restarts: [],
  canarySentAt: null,
  lastStatus: 'unknown',
  breakerTrippedAt: null,
  lastRestartAt: null,
  promptCount: 0,
};

export class StateManager {
  private readonly stateFile: string;

  constructor(stateFile: string) {
    this.stateFile = stateFile;
  }

  async load(): Promise<WatchdogState> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<WatchdogState>;
      // Merge with defaults to handle missing fields from old bash state format
      return {
        restarts: Array.isArray(parsed.restarts) ? parsed.restarts : (parsed as any).restarts ?? [],
        canarySentAt: parsed.canarySentAt ?? (parsed as any).canary_sent_at ?? null,
        lastStatus: parsed.lastStatus ?? (parsed as any).last_status ?? 'unknown',
        breakerTrippedAt: parsed.breakerTrippedAt ?? (parsed as any).breaker_tripped_at ?? null,
        lastRestartAt: parsed.lastRestartAt ?? null,
        promptCount: parsed.promptCount ?? 0,
      };
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  async save(state: WatchdogState): Promise<void> {
    const tmp = this.stateFile + '.tmp';
    try {
      await fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
      await fs.rename(tmp, this.stateFile);
    } catch (err) {
      // Attempt cleanup of tmp
      try { await fs.unlink(tmp); } catch { /* ignore */ }
      throw err;
    }
  }
}
