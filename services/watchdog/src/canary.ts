/**
 * canary.ts — CanarySender: injects a watchdog canary into a tmux session
 */

import { exec as execCallback } from 'child_process';
import { promisify } from 'util';

const execDefault = promisify(execCallback);

export interface CanaryConfig {
  tmuxSession: string;
  canaryTimeoutSec: number;
  /** Injectable exec function for testing */
  execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
}

export interface CanaryResult {
  sent: boolean;
  canarySentAt: number | null;
  error?: string;
}

export class CanarySender {
  private readonly config: CanaryConfig;
  private readonly exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;

  constructor(config: CanaryConfig) {
    this.config = config;
    this.exec = config.execFn ?? execDefault;
  }

  async sendIfNeeded(canarySentAt: number | null): Promise<CanaryResult> {
    const nowSec = Math.floor(Date.now() / 1000);

    // Skip if within timeout window
    if (canarySentAt !== null) {
      const age = nowSec - canarySentAt;
      if (age < this.config.canaryTimeoutSec) {
        return { sent: false, canarySentAt };
      }
    }

    // Send canary
    const canaryId = `watchdog-canary-${nowSec}`;
    const cmd = `tmux send-keys -t ${this.config.tmuxSession} "# ${canaryId}" Enter`;

    try {
      await this.exec(cmd);
      return { sent: true, canarySentAt: nowSec };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { sent: false, canarySentAt: null, error };
    }
  }
}
