/**
 * hang-detector.ts — Detects slow hangs that keep the heartbeat fresh but make
 * no real forward progress.
 *
 * The bash/TS watchdog already catches crash loops (tmux session missing) and
 * stale heartbeats (canary times out). The gap (2026-06-16 incident): Wren
 * stayed alive enough to refresh its heartbeat — Discord reactions fired and the
 * canary tmux comment triggered a Stop hook — but the real work loop was wedged
 * for ~4h.
 *
 * The FIRST version of this detector (also 2026-06-16) tried to catch that via
 * absence-of-progress signals — prompt_count growth, agent_activity, open
 * agent_episodes. All three turned out to be degenerate (prompt_count is never
 * incremented, episodes are never closed), so it false-positived and bounced
 * claude-discord every 60s. See project memory: wren-watchdog-hang-false-positive.
 *
 * This version uses POSITIVE, canary-proof, file-based signals written by the
 * Claude hooks. The key property: a watchdog canary (a `# watchdog-canary-…`
 * tmux comment) touches NONE of these, so it can never mask a real hang:
 *
 *   last_prompt_at   — UserPromptSubmit hook (discord-activity.sh), written ONLY
 *                      for real Discord messages (the canary fails the
 *                      source="plugin:discord:discord" check and is ignored).
 *                      = "a genuine prompt arrived."
 *   last_response_at — Stop hook (heartbeat-on-stop.sh), written ONLY when a
 *                      pending real-message reaction exists (the canary never
 *                      writes pending_reaction.json). = "a genuine response was
 *                      delivered."
 *   last_tool_at     — PostToolUse hook, written on every tool call.
 *                      = "the work loop is alive and executing tools."
 *
 * Hang = a genuine prompt has been outstanding (no later genuine response) for
 * ≥ threshold AND there has been no tool activity for ≥ threshold. This cannot
 * false-positive when idle (no outstanding prompt), when responding normally
 * (the response clears the outstanding prompt), or during a long legitimate task
 * (tool calls keep last_tool_at fresh) — yet it still catches the canary-masked
 * wedge the detector was built for.
 */

import { promises as fs } from 'fs';
import { LocalLogger } from './logger.js';

export interface HangDetectorConfig {
  /** File holding epoch-sec of the last genuine inbound prompt. */
  lastPromptAtFile: string;
  /** File holding epoch-sec of the last genuine response delivered. */
  lastResponseAtFile: string;
  /** File holding epoch-sec of the last tool execution. */
  lastToolAtFile: string;
  /**
   * Minutes a genuine prompt may stay unanswered — with no tool activity — before
   * the work loop is declared hung.
   */
  hangThresholdMin: number;
  /** Fallback log for read failures. */
  fallbackLogFile?: string;
}

export interface HangSignals {
  /** Epoch-sec of the newest genuine inbound prompt, or null if none recorded. */
  lastPromptAt: number | null;
  /** Epoch-sec of the newest genuine response delivered, or null. */
  lastResponseAt: number | null;
  /** Epoch-sec of the newest tool execution, or null. */
  lastToolAt: number | null;
}

export interface HangAssessmentInput {
  nowSec: number;
  signals: HangSignals;
}

export interface HangAssessment {
  isHung: boolean;
  reasons: string[];
}

export class HangDetector {
  private readonly config: HangDetectorConfig;
  private readonly fallbackLogger: LocalLogger | null;

  constructor(config: HangDetectorConfig) {
    this.config = config;
    this.fallbackLogger = config.fallbackLogFile
      ? new LocalLogger(config.fallbackLogFile)
      : null;
  }

  /** Read the three signal files. Never throws — a missing/corrupt file is null. */
  async fetchSignals(): Promise<HangSignals> {
    const [lastPromptAt, lastResponseAt, lastToolAt] = await Promise.all([
      this.readEpoch(this.config.lastPromptAtFile),
      this.readEpoch(this.config.lastResponseAtFile),
      this.readEpoch(this.config.lastToolAtFile),
    ]);
    return { lastPromptAt, lastResponseAt, lastToolAt };
  }

  private async readEpoch(file: string): Promise<number | null> {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const n = parseInt(raw.trim(), 10);
      return !isNaN(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Pure assessment — no I/O. A genuine prompt is "outstanding" when the newest
   * prompt has no response recorded at or after it. The loop is hung when such a
   * prompt has been outstanding past the threshold AND no tool has run in that
   * window (so a long-but-healthy task, which keeps emitting tool calls, is not
   * flagged).
   */
  assess(input: HangAssessmentInput): HangAssessment {
    const { nowSec, signals } = input;
    const { lastPromptAt, lastResponseAt, lastToolAt } = signals;
    const thresholdSec = this.config.hangThresholdMin * 60;

    const promptOutstanding =
      lastPromptAt !== null &&
      (lastResponseAt === null || lastResponseAt < lastPromptAt);
    const promptAgeSec = lastPromptAt !== null ? nowSec - lastPromptAt : 0;
    const toolStaleSec = lastToolAt !== null ? nowSec - lastToolAt : Infinity;

    const noResponseLongEnough = promptOutstanding && promptAgeSec >= thresholdSec;
    // A missing last_tool_at file (never recorded — e.g. fresh deploy) is treated
    // as "unknown", NOT as stale, so we fail safe and do not flag a hang before
    // the tool-activity signal has ever been written.
    const noToolActivity = lastToolAt !== null && toolStaleSec >= thresholdSec;

    const isHung = noResponseLongEnough && noToolActivity;

    const reasons: string[] = [];
    if (isHung) {
      reasons.push(
        `genuine prompt unanswered for ${promptAgeSec}s (threshold ${thresholdSec}s)`,
      );
      reasons.push(
        lastResponseAt === null
          ? 'no genuine response ever recorded'
          : `last genuine response ${nowSec - lastResponseAt}s ago, before the outstanding prompt`,
      );
      reasons.push(
        `no tool activity for ${toolStaleSec}s (threshold ${thresholdSec}s)`,
      );
    }

    return { isHung, reasons };
  }
}
