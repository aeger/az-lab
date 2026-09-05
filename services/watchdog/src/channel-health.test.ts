import { describe, it, expect } from 'vitest';
import {
  parseProcTable,
  assessProcTable,
  ChannelHealthChecker,
  decideChannelAction,
} from './channel-health.js';

const BRIDGE = '--name discord-bridge';
const MCP = ['claude-plugins-official/discord', 'server.ts'];

/** The real shape, from svc-podman-01 on 2026-09-05. */
const HEALTHY_PS = `
   1087      1 /lib/systemd/systemd --user
3848092   1087 /bin/bash /home/almty1/.local/bin/claude-discord-start
3848097   1087 tmux new-session -d -s claude-discord /home/almty1/.bun/bin/claude --permission-mode dontAsk --name discord-bridge --channels plugin:discord@claude-plugins-official
3848100 3848097 /home/almty1/.bun/bin/claude --permission-mode dontAsk --name discord-bridge --channels plugin:discord@claude-plugins-official
3848215 3848100 bun run --cwd /home/almty1/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start
3848220 3848215 /home/almty1/.bun/bin/bun server.ts
`;

/** The 2026-09-04 failure: claude alive, MCP child gone. */
const DEAF_PS = `
   1087      1 /lib/systemd/systemd --user
3199825   1087 /bin/bash /home/almty1/.local/bin/claude-discord-start
3199829   1087 tmux new-session -d -s claude-discord /home/almty1/.bun/bin/claude --permission-mode dontAsk --name discord-bridge --channels plugin:discord@claude-plugins-official
3199830 3199829 /home/almty1/.bun/bin/claude --permission-mode dontAsk --name discord-bridge --channels plugin:discord@claude-plugins-official
3843199 3843192 /home/almty1/.bun/bin/bun server.ts
3843192 3843121 bun run --cwd /home/almty1/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start
3843121      1 claude
`;

describe('parseProcTable', () => {
  it('parses pid, ppid and the full argv', () => {
    const rows = parseProcTable(HEALTHY_PS);
    expect(rows).toHaveLength(6);
    expect(rows[5]).toEqual({
      pid: 3848220,
      ppid: 3848215,
      args: '/home/almty1/.bun/bin/bun server.ts',
    });
  });

  it('ignores blank and malformed lines', () => {
    expect(parseProcTable('\n\nnot a row\n  12 34 /bin/true\n')).toEqual([
      { pid: 12, ppid: 34, args: '/bin/true' },
    ]);
  });
});

describe('assessProcTable', () => {
  it('reports healthy when the MCP server is a live descendant', () => {
    const r = assessProcTable(parseProcTable(HEALTHY_PS), BRIDGE, MCP);
    expect(r.healthy).toBe(true);
    expect(r.bridgePid).toBe(3848100);
    expect(r.mcpPids).toEqual([3848215, 3848220]);
  });

  it('picks the claude process, not the tmux wrapper carrying the same argv', () => {
    const r = assessProcTable(parseProcTable(HEALTHY_PS), BRIDGE, MCP);
    expect(r.bridgePid).not.toBe(3848097);
  });

  it('reports deaf when the bridge has no MCP descendants (2026-09-04)', () => {
    const r = assessProcTable(parseProcTable(DEAF_PS), BRIDGE, MCP);
    expect(r.healthy).toBe(false);
    expect(r.bridgePid).toBe(3199830);
    expect(r.reason).toContain('no live Discord MCP server');
  });

  it('does not count another session\'s MCP server as the bridge\'s', () => {
    // 3843199/3843192 belong to pid 3843121, an unrelated interactive session.
    const r = assessProcTable(parseProcTable(DEAF_PS), BRIDGE, MCP);
    expect(r.mcpPids).toEqual([]);
  });

  it('reports deaf when the wrapper survives but server.ts is gone', () => {
    const ps = `
3848100 3848097 /home/almty1/.bun/bin/claude --permission-mode dontAsk --name discord-bridge --channels plugin:discord@claude-plugins-official
3848215 3848100 bun run --cwd /home/almty1/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start
`;
    const r = assessProcTable(parseProcTable(ps), BRIDGE, MCP);
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('server.ts');
  });

  it('defers to the heartbeat path when no bridge process exists', () => {
    const r = assessProcTable(parseProcTable('1087 1 /lib/systemd/systemd --user'), BRIDGE, MCP);
    expect(r.healthy).toBe(true);
    expect(r.bridgePid).toBeNull();
    expect(r.reason).toContain('deferring');
  });

  it('judges the newest bridge while a restart is mid-flight', () => {
    const ps = `
100 1 /home/almty1/.bun/bin/claude --name discord-bridge --channels plugin:discord@claude-plugins-official
200 1 /home/almty1/.bun/bin/claude --name discord-bridge --channels plugin:discord@claude-plugins-official
201 200 bun run --cwd /home/almty1/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --shell=bun --silent start
202 201 /home/almty1/.bun/bin/bun server.ts
`;
    const r = assessProcTable(parseProcTable(ps), BRIDGE, MCP);
    expect(r.healthy).toBe(true);
    expect(r.bridgePid).toBe(200);
  });
});

describe('ChannelHealthChecker', () => {
  it('shells out once and assesses the result', async () => {
    const calls: string[] = [];
    const checker = new ChannelHealthChecker({
      bridgeMatch: BRIDGE,
      mcpMatch: MCP,
      execFn: async cmd => {
        calls.push(cmd);
        return { stdout: DEAF_PS, stderr: '' };
      },
    });
    const r = await checker.check();
    expect(calls).toEqual(['ps -eo pid=,ppid=,args=']);
    expect(r.healthy).toBe(false);
  });

  it('never reports deaf on a failed measurement', async () => {
    const checker = new ChannelHealthChecker({
      bridgeMatch: BRIDGE,
      mcpMatch: MCP,
      execFn: async () => {
        throw new Error('ps: command not found');
      },
    });
    const r = await checker.check();
    expect(r.healthy).toBe(true);
    expect(r.reason).toContain('process table unavailable');
  });
});

describe('decideChannelAction', () => {
  const base = {
    nowSec: 1_000_000,
    deafThresholdSec: 120,
    sinceRestartSec: Infinity,
    restartGraceSec: 180,
  };

  it('clears the marker while attached', () => {
    expect(decideChannelAction({ ...base, healthy: true, channelDeafSince: 999_000 }))
      .toEqual({ action: 'ok', deafSince: null, deafForSec: 0 });
  });

  it('stays quiet while a restart is still settling', () => {
    const d = decideChannelAction({ ...base, healthy: false, channelDeafSince: null, sinceRestartSec: 30 });
    expect(d.action).toBe('grace');
  });

  it('starts the clock on first sighting rather than acting', () => {
    const d = decideChannelAction({ ...base, healthy: false, channelDeafSince: null });
    expect(d.action).toBe('hold');
    expect(d.deafSince).toBe(base.nowSec);
    expect(d.deafForSec).toBe(0);
  });

  it('carries deafSince forward so the clock actually advances', () => {
    // The bug this guards: clearing the marker each tick pinned deafForSec at 0
    // and the threshold was unreachable.
    const first = decideChannelAction({ ...base, healthy: false, channelDeafSince: null });
    const later = decideChannelAction({
      ...base,
      healthy: false,
      channelDeafSince: first.deafSince,
      nowSec: base.nowSec + 60,
    });
    expect(later.action).toBe('hold');
    expect(later.deafForSec).toBe(60);
  });

  it('acts once deafness outlasts the threshold', () => {
    const d = decideChannelAction({
      ...base,
      healthy: false,
      channelDeafSince: base.nowSec - 120,
    });
    expect(d.action).toBe('act');
    expect(d.deafForSec).toBe(120);
  });

  it('reaches act after enough consecutive hold ticks', () => {
    let deafSince: number | null = null;
    let action = '';
    for (let i = 0; i <= 3; i++) {
      const d = decideChannelAction({
        ...base,
        healthy: false,
        channelDeafSince: deafSince,
        nowSec: base.nowSec + i * 60,
      });
      deafSince = d.deafSince;
      action = d.action;
    }
    expect(action).toBe('act');
  });
});
