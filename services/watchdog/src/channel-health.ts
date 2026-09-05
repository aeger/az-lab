/**
 * channel-health.ts — can the bridge still hear Discord at all?
 *
 * The canary only proves the session answers a prompt typed into its tmux pane.
 * It cannot see whether that session still has its Discord MCP server attached.
 * On 2026-09-04 the bridge's `plugin:discord:discord` server dropped ten minutes
 * after startup and the canary reported "alive, idle" every ten minutes for the
 * following eleven hours while every question asked in Discord went unanswered.
 * systemd also reported the unit healthy the whole time — the tmux session and
 * the `claude` process were both fine; only the MCP child was gone.
 *
 * So this checks the one thing neither of those can see: that the bridge
 * `claude` process still has live Discord MCP descendants. It is purely
 * process-level, which is the point — it needs no cooperation from the model
 * and cannot be satisfied by a session that is merely responsive.
 */

import { exec as execCallback } from 'child_process';
import { promisify } from 'util';

const execDefault = promisify(execCallback);

/** One row of `ps -eo pid=,ppid=,args=`. */
export interface ProcRow {
  pid: number;
  ppid: number;
  args: string;
}

export interface ChannelHealthConfig {
  /** argv fragment identifying the bridge's own `claude` process. */
  bridgeMatch: string;
  /** argv fragments that must ALL appear among the bridge's descendants. */
  mcpMatch: string[];
  /** Injectable exec function for testing */
  execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
}

export interface ChannelHealthResult {
  healthy: boolean;
  bridgePid: number | null;
  mcpPids: number[];
  /** Human-readable — goes straight into the log line and the Discord alert. */
  reason: string;
}

export function parseProcTable(stdout: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] });
  }
  return rows;
}

/**
 * The bridge is the `claude` process itself, not the `tmux new-session` that
 * launched it — both carry the same `--name discord-bridge` in their argv, so
 * matching on the fragment alone picks up the wrapper too.
 */
function isBridgeProcess(row: ProcRow, bridgeMatch: string): boolean {
  if (!row.args.includes(bridgeMatch)) return false;
  const exe = row.args.trim().split(/\s+/)[0] ?? '';
  const base = exe.split('/').pop() ?? '';
  return base === 'claude';
}

function descendantsOf(rows: ProcRow[], rootPid: number): ProcRow[] {
  const byParent = new Map<number, ProcRow[]>();
  for (const r of rows) {
    const siblings = byParent.get(r.ppid);
    if (siblings) siblings.push(r);
    else byParent.set(r.ppid, [r]);
  }
  const out: ProcRow[] = [];
  const queue = [rootPid];
  const seen = new Set<number>([rootPid]);
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid)) continue; // defensive: ps snapshots can lie
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

export function assessProcTable(
  rows: ProcRow[],
  bridgeMatch: string,
  mcpMatch: string[],
): ChannelHealthResult {
  const bridges = rows.filter(r => isBridgeProcess(r, bridgeMatch));

  if (bridges.length === 0) {
    // Not our call to make: a missing process is the heartbeat/canary path's
    // problem, and claiming "deaf" here would double-restart during a bounce.
    return {
      healthy: true,
      bridgePid: null,
      mcpPids: [],
      reason: 'bridge process not running — deferring to heartbeat checks',
    };
  }

  // More than one bridge means a restart is mid-flight; take the newest, which
  // ps lists last, rather than failing on the one that is on its way out.
  const bridge = bridges[bridges.length - 1]!;
  const kin = descendantsOf(rows, bridge.pid);

  const missing = mcpMatch.filter(frag => !kin.some(k => k.args.includes(frag)));
  const mcpPids = kin
    .filter(k => mcpMatch.some(frag => k.args.includes(frag)))
    .map(k => k.pid);

  if (missing.length > 0) {
    return {
      healthy: false,
      bridgePid: bridge.pid,
      mcpPids,
      reason:
        `bridge pid ${bridge.pid} has no live Discord MCP server ` +
        `(missing: ${missing.join(', ')}; ${kin.length} descendant process(es))`,
    };
  }

  return {
    healthy: true,
    bridgePid: bridge.pid,
    mcpPids,
    reason: `bridge pid ${bridge.pid} has Discord MCP attached (${mcpPids.join(', ')})`,
  };
}

export class ChannelHealthChecker {
  private readonly config: ChannelHealthConfig;
  private readonly exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;

  constructor(config: ChannelHealthConfig) {
    this.config = config;
    this.exec = config.execFn ?? execDefault;
  }

  async check(): Promise<ChannelHealthResult> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec('ps -eo pid=,ppid=,args='));
    } catch (err) {
      // Can't see the process table — report healthy rather than restart the
      // bridge on the strength of a broken measurement.
      return {
        healthy: true,
        bridgePid: null,
        mcpPids: [],
        reason: `process table unavailable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return assessProcTable(parseProcTable(stdout), this.config.bridgeMatch, this.config.mcpMatch);
  }
}

/** What the watchdog should do about the current channel-health reading. */
export type ChannelAction =
  /** Attached, or not measurable — carry on with the normal healthy path. */
  | 'ok'
  /** Deaf, but a restart is still settling; expected, do nothing. */
  | 'grace'
  /** Deaf, but not yet for long enough to be sure. Hold the marker. */
  | 'hold'
  /** Deaf past the threshold — restart the bridge. */
  | 'act';

export interface ChannelDecision {
  action: ChannelAction;
  /** epoch-sec to persist as channelDeafSince (null clears it). */
  deafSince: number | null;
  /** How long it has looked deaf, for the log line and the alert. */
  deafForSec: number;
}

/**
 * Pure so the state machine can be tested without a process table. The subtle
 * part is that 'hold' MUST keep deafSince: the caller has to persist it and
 * stop, because falling through to the healthy path would clear the marker,
 * reset the clock every tick, and the threshold would never be reached.
 */
export function decideChannelAction(input: {
  healthy: boolean;
  channelDeafSince: number | null;
  nowSec: number;
  deafThresholdSec: number;
  sinceRestartSec: number;
  restartGraceSec: number;
}): ChannelDecision {
  const { healthy, channelDeafSince, nowSec, deafThresholdSec, sinceRestartSec, restartGraceSec } = input;

  if (healthy) return { action: 'ok', deafSince: null, deafForSec: 0 };

  // A bridge that restarted seconds ago has not had time to attach its MCP
  // server yet; treating that as deafness would restart it in a loop.
  if (sinceRestartSec < restartGraceSec) {
    return { action: 'grace', deafSince: channelDeafSince, deafForSec: 0 };
  }

  const deafSince = channelDeafSince ?? nowSec;
  const deafForSec = nowSec - deafSince;
  if (deafForSec >= deafThresholdSec) {
    return { action: 'act', deafSince, deafForSec };
  }
  return { action: 'hold', deafSince, deafForSec };
}
