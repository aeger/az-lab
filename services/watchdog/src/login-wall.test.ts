import { describe, it, expect } from 'vitest';
import {
  parseCredentials,
  extractCanaryReply,
  assessLoginWall,
  assessExpiryWarning,
  canaryIdFor,
  LoginWallDetector,
  type CredentialState,
} from './login-wall.js';

const NOW_MS = 1_789_680_000_000; // 2026-09-17T21:20:00Z
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The pane as it read on 2026-09-17, canary answered by the login wall. */
const WALLED_PANE = `
  I'll take a look at that now.

❯ watchdog-canary-1789662405
● Login expired · Please run /login
✻ Cogitated for 0s · done 4:26 PM
                                                    Not logged in · Run /login
─────────────────────────────────────────────────────────── discord-bridge ─
`;

/** Healthy pane: same canary id, a real (if terse) turn under it. */
const HEALTHY_PANE = `
❯ watchdog-canary-1789662405
● Noted — nothing to do.
✻ Thought for 3s · done 4:26 PM
─────────────────────────────────────────────────────────── discord-bridge ─
`;

/**
 * The trap this detector has to survive: on 2026-09-17 the bridge was ASKED
 * about the incident, so the words "Login expired" and the stale status line
 * were both sitting in the pane while auth was perfectly fine.
 */
const INCIDENT_DISCUSSION_PANE = `
● The TUI answered every canary with "Login expired · Please run /login", so no
  Stop hook ever fired and the watchdog called it a hang.
✻ Churned for 4m 57s · done 4:57 PM
                                                    Not logged in · Run /login
─────────────────────────────────────────────────────────── discord-bridge ─
❯ watchdog-canary-1789662405
`;

function creds(over: Partial<CredentialState> = {}): CredentialState {
  return {
    verdict: 'ok',
    expiresAt: NOW_MS + 8 * HOUR,
    refreshTokenExpiresAt: NOW_MS + 28 * DAY,
    accessExpiresInSec: 8 * 3600,
    refreshExpiresInSec: 28 * 86400,
    detail: 'access token valid for 28800s',
    ...over,
  };
}

describe('parseCredentials', () => {
  const body = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: o });

  it('reads the real file shape — epoch MILLISECONDS, not seconds', () => {
    const s = parseCredentials(
      body({ expiresAt: NOW_MS + 4 * HOUR, refreshTokenExpiresAt: NOW_MS + 28 * DAY }),
      NOW_MS,
    );
    expect(s.verdict).toBe('ok');
    expect(s.accessExpiresInSec).toBe(4 * 3600);
    expect(s.refreshExpiresInSec).toBe(28 * 86400);
  });

  it('calls an expired access token routine while the refresh token lives', () => {
    const s = parseCredentials(
      body({ expiresAt: NOW_MS - HOUR, refreshTokenExpiresAt: NOW_MS + 28 * DAY }),
      NOW_MS,
    );
    expect(s.verdict).toBe('access_expired');
    expect(s.accessExpiresInSec).toBe(-3600);
  });

  it('flags a dead refresh token as needing a human', () => {
    const s = parseCredentials(
      body({ expiresAt: NOW_MS - 28 * DAY, refreshTokenExpiresAt: NOW_MS - DAY }),
      NOW_MS,
    );
    expect(s.verdict).toBe('reauth_needed');
    expect(s.detail).toContain('/login');
  });

  it('reports missing / unreadable rather than guessing', () => {
    expect(parseCredentials(null, NOW_MS).verdict).toBe('missing');
    expect(parseCredentials('{', NOW_MS).verdict).toBe('unreadable');
    expect(parseCredentials('{"mcpOAuth":{}}', NOW_MS).verdict).toBe('missing');
    expect(parseCredentials(body({ subscriptionType: 'max' }), NOW_MS).verdict).toBe('missing');
  });

  it('ignores zero and non-numeric expiry values', () => {
    const s = parseCredentials(body({ expiresAt: 0, refreshTokenExpiresAt: 'soon' }), NOW_MS);
    expect(s.verdict).toBe('missing');
  });
});

describe('extractCanaryReply', () => {
  it('returns only what came after the canary echo', () => {
    const reply = extractCanaryReply(WALLED_PANE, 'watchdog-canary-1789662405');
    expect(reply).toContain('Login expired');
    expect(reply).not.toContain("I'll take a look");
  });

  it('returns null when the canary has scrolled out of the capture', () => {
    expect(extractCanaryReply(HEALTHY_PANE, 'watchdog-canary-9999999999')).toBeNull();
  });

  it('uses the LAST echo, so an older canary in scrollback cannot answer for a newer one', () => {
    const pane = [
      '❯ watchdog-canary-1',
      '● Login expired · Please run /login',
      '❯ watchdog-canary-1',
      '● All good.',
    ].join('\n');
    expect(extractCanaryReply(pane, 'watchdog-canary-1')).toBe('● All good.');
  });
});

describe('assessLoginWall', () => {
  const canaryId = 'watchdog-canary-1789662405';

  it('detects the 2026-09-17 wall from the canary reply', () => {
    const r = assessLoginWall({ pane: WALLED_PANE, canaryId, creds: creds({ verdict: 'access_expired' }) });
    expect(r.wall).toBe(true);
    expect(r.trigger).toBe('canary_reply');
    expect(r.evidence.canaryReplyMarker).toBe('Login expired');
  });

  it('does NOT fire on a healthy canary reply', () => {
    const r = assessLoginWall({ pane: HEALTHY_PANE, canaryId, creds: creds() });
    expect(r.wall).toBe(false);
    expect(r.trigger).toBeNull();
  });

  it('does NOT fire when the bridge merely TALKED about a login wall', () => {
    // The marker text is in the pane, but above the canary echo, and the
    // credentials are good — this must stay restartable.
    const r = assessLoginWall({ pane: INCIDENT_DISCUSSION_PANE, canaryId, creds: creds() });
    expect(r.wall).toBe(false);
    expect(r.evidence.canaryReplyMarker).toBeNull();
    expect(r.reason).toContain('stale');
  });

  it('treats a dead refresh token as a wall even with no pane at all', () => {
    const r = assessLoginWall({
      pane: null,
      canaryId,
      creds: creds({ verdict: 'reauth_needed', detail: 'refresh token expired 60s ago' }),
    });
    expect(r.wall).toBe(true);
    expect(r.trigger).toBe('reauth_needed');
    expect(r.evidence.paneAvailable).toBe(false);
  });

  it('treats missing credentials as a wall', () => {
    const r = assessLoginWall({ pane: HEALTHY_PANE, canaryId, creds: creds({ verdict: 'missing' }) });
    expect(r.wall).toBe(true);
    expect(r.trigger).toBe('credentials_missing');
  });

  it('accepts the status line only when the credentials corroborate it', () => {
    const paneWithStatusOnly = 'some output\n            Not logged in · Run /login\n';
    expect(
      assessLoginWall({ pane: paneWithStatusOnly, canaryId, creds: creds({ verdict: 'access_expired' }) }).wall,
    ).toBe(true);
    // Same pane, healthy tokens on disk: a restart could genuinely help here,
    // so the normal restart path must not be suppressed.
    expect(assessLoginWall({ pane: paneWithStatusOnly, canaryId, creds: creds() }).wall).toBe(false);
  });

  it('ignores the pane entirely when no canary is outstanding', () => {
    const r = assessLoginWall({ pane: WALLED_PANE, canaryId: null, creds: creds() });
    expect(r.wall).toBe(false);
    expect(r.evidence.canaryEchoFound).toBe(false);
  });
});

describe('assessExpiryWarning', () => {
  const WARN = 3 * 86400;

  it('stays quiet while the refresh token is comfortable', () => {
    expect(assessExpiryWarning(creds(), WARN, null).warn).toBe(false);
  });

  it('warns ahead of expiry, not after', () => {
    const soon = creds({ refreshTokenExpiresAt: NOW_MS + 2 * DAY, refreshExpiresInSec: 2 * 86400 });
    const w = assessExpiryWarning(soon, WARN, null);
    expect(w.warn).toBe(true);
    expect(w.reason).toContain('before then');
  });

  it('warns once per token, not once per poll', () => {
    const soon = creds({ refreshTokenExpiresAt: NOW_MS + 2 * DAY, refreshExpiresInSec: 2 * 86400 });
    expect(assessExpiryWarning(soon, WARN, NOW_MS + 2 * DAY).warn).toBe(false);
    // A re-auth issues a new expiry, which is warnable again.
    expect(assessExpiryWarning(soon, WARN, NOW_MS + 99 * DAY).warn).toBe(true);
  });

  it('does not warn on an access token — only the refresh token needs a human', () => {
    const accessGone = creds({
      verdict: 'access_expired',
      expiresAt: NOW_MS - HOUR,
      accessExpiresInSec: -3600,
    });
    expect(assessExpiryWarning(accessGone, WARN, null).warn).toBe(false);
  });
});

describe('LoginWallDetector', () => {
  const credsJson = JSON.stringify({
    claudeAiOauth: { expiresAt: NOW_MS - HOUR, refreshTokenExpiresAt: NOW_MS + 28 * DAY },
  });

  it('captures the pane for the configured session and reports the wall', async () => {
    const calls: string[] = [];
    const det = new LoginWallDetector({
      tmuxSession: 'claude-discord',
      credentialsFile: '/nope/.credentials.json',
      paneLines: 50,
      execFn: async (cmd) => {
        calls.push(cmd);
        return { stdout: WALLED_PANE, stderr: '' };
      },
      readFileFn: async () => credsJson,
    });

    const r = await det.check('watchdog-canary-1789662405', NOW_MS);
    expect(calls[0]).toBe("tmux capture-pane -p -S -50 -t 'claude-discord'");
    expect(r.wall).toBe(true);
    expect(r.trigger).toBe('canary_reply');
  });

  it('survives a dead tmux — no pane is not a verdict', async () => {
    const det = new LoginWallDetector({
      tmuxSession: 'claude-discord',
      credentialsFile: '/nope/.credentials.json',
      paneLines: 50,
      execFn: async () => {
        throw new Error("can't find session: claude-discord");
      },
      readFileFn: async () => credsJson,
    });

    const r = await det.check('watchdog-canary-1789662405', NOW_MS);
    // tmux is gone and the tokens are fine — that is the heartbeat path's
    // problem, and a restart is the right remedy, so do not suppress it.
    expect(r.wall).toBe(false);
    expect(r.evidence.paneAvailable).toBe(false);
  });

  it('reports missing credentials rather than throwing', async () => {
    const det = new LoginWallDetector({
      tmuxSession: 'claude-discord',
      credentialsFile: '/nope/.credentials.json',
      paneLines: 50,
      execFn: async () => ({ stdout: HEALTHY_PANE, stderr: '' }),
      readFileFn: async () => {
        throw new Error('ENOENT');
      },
    });
    const r = await det.check('watchdog-canary-1789662405', NOW_MS);
    expect(r.wall).toBe(true);
    expect(r.trigger).toBe('credentials_missing');
  });
});

describe('canaryIdFor', () => {
  it('rebuilds the id CanarySender typed into the pane', () => {
    // Must match canary.ts: `watchdog-canary-${nowSec}`.
    expect(canaryIdFor(1789662405)).toBe('watchdog-canary-1789662405');
    expect(canaryIdFor(null)).toBeNull();
  });
});
