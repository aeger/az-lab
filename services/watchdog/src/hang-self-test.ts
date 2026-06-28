/**
 * hang-self-test.ts — In-process smoke test for the hang-detection assess()
 * logic. Runs on watchdog startup so a refactor that quietly breaks the new
 * hang detection (the path that took ~4h to surface on 2026-06-16) gets caught
 * the moment the service restarts, not the next time Wren actually hangs.
 *
 * Pure assertions only — no network, no fs.
 */

import { HangDetector, HangSignals } from './hang-detector.js';

export interface SelfTestResult {
  ok: boolean;
  checks: number;
  failures: string[];
}

export function runHangSelfTest(detector: HangDetector): SelfTestResult {
  const failures: string[] = [];
  let checks = 0;

  const check = (label: string, condition: boolean): void => {
    checks += 1;
    if (!condition) failures.push(label);
  };

  const now = 1_700_000_000; // arbitrary, deterministic
  const longAgo = now - 30 * 60; // 30 minutes ago — past the 20m threshold
  const shortAgo = now - 5 * 60; // 5 minutes ago — under the threshold

  // 1. The smoking-gun scenario: a genuine prompt arrived 30m ago, no genuine
  //    response since, and no tool activity for 30m — the canary-masked wedge.
  const hung = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: longAgo, lastResponseAt: null, lastToolAt: longAgo },
  });
  check('hung_scenario_detected', hung.isHung === true);
  check('hung_scenario_has_reasons', hung.reasons.length >= 3);

  // 2. Canary-masked variant: a stale response exists but it predates the
  //    outstanding prompt; the canary kept the heartbeat warm but touched none
  //    of these signals. Still a hang.
  const hungWithStaleResponse = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: longAgo, lastResponseAt: longAgo - 60, lastToolAt: longAgo },
  });
  check('hung_with_stale_prior_response', hungWithStaleResponse.isHung === true);

  // 3. Responding normally — the response is newer than the prompt. Never hung.
  const responded = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: longAgo, lastResponseAt: shortAgo, lastToolAt: shortAgo },
  });
  check('responded_not_hung', responded.isHung === false);

  // 4. Long but healthy task — prompt outstanding 30m, but tools are still
  //    firing (1m ago). Must NOT flag.
  const longTask = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: longAgo, lastResponseAt: null, lastToolAt: shortAgo },
  });
  check('long_task_with_tools_not_hung', longTask.isHung === false);

  // 5. Idle — last prompt was answered long ago, nothing new. Must NOT flag.
  const idle = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: longAgo - 120, lastResponseAt: longAgo, lastToolAt: longAgo },
  });
  check('idle_answered_not_hung', idle.isHung === false);

  // 6. No prompt ever recorded — must NOT flag.
  const noPrompt = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: null, lastResponseAt: null, lastToolAt: longAgo },
  });
  check('no_prompt_not_hung', noPrompt.isHung === false);

  // 7. Fresh deploy — outstanding prompt but last_tool_at never written. Fail
  //    safe: a missing tool signal is "unknown", not "stale". Must NOT flag.
  const noToolSignal = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: longAgo, lastResponseAt: null, lastToolAt: null },
  });
  check('missing_tool_signal_not_hung', noToolSignal.isHung === false);

  // 8. Prompt outstanding but only briefly (5m) with no tools — under threshold,
  //    must NOT flag yet.
  const recentPrompt = detector.assess({
    nowSec: now,
    signals: { lastPromptAt: shortAgo, lastResponseAt: null, lastToolAt: longAgo },
  });
  check('recent_prompt_under_threshold_not_hung', recentPrompt.isHung === false);

  return { ok: failures.length === 0, checks, failures };
}
