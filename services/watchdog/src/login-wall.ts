/**
 * login-wall.ts — is the bridge behind a `/login` wall rather than wedged?
 *
 * The canary proves a prompt was answered. It does not prove a *model turn*
 * ran. On 2026-09-17 the bridge's Claude Code OAuth token expired and the TUI
 * answered every canary in 0s with `● Login expired · Please run /login`.
 * Because no model turn ran, no Stop hook fired, so the watchdog's response
 * detector saw nothing and logged "Canary timed out — Wren is unresponsive".
 * It restarted claude-discord five times and tripped the breaker three times
 * between 15:07 and 16:06 UTC. Host load was 0.22 the whole way: never a hang.
 *
 * A restart cannot clear an auth failure — only a human running `/login` can.
 * So this module reads the two things the response detector cannot see:
 *
 *   1. the pane the canary was answered in (`tmux capture-pane`), and
 *   2. `~/.claude/.credentials.json`, which says when the tokens die.
 *
 * Same class of gap as the 2026-09-04 channel-health detector: see
 * channel-health.ts.
 *
 * FALSE-POSITIVE DISCIPLINE. Suppressing restarts is a powerful lever, so the
 * pane evidence is deliberately narrow:
 *
 *   - Only the text AFTER the last echo of the canary id counts as the canary's
 *     reply. The pane routinely contains the words "Login expired" for innocent
 *     reasons — Wren discussing this very incident put them there on 2026-09-17
 *     — and a whole-pane grep would latch onto that forever.
 *   - The `Not logged in` status line is treated as weak evidence only. It is
 *     not redrawn when a session is idle, so it goes stale: minutes after Jeff
 *     re-authed at 16:34 UTC the bridge pane still showed it while the
 *     credentials on disk were valid for another eight hours.
 *   - If the canary echo cannot be found in the pane, the pane is ignored
 *     entirely and only the credential file decides.
 */

import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';

const execDefault = promisify(execCallback);

/**
 * Markers that only a login wall produces, matched against the canary's own
 * reply. `Login expired` and `Please run /login` are the two observed on
 * 2026-09-17; `Invalid API key` is the same wall reached by a different route.
 */
export const CANARY_REPLY_MARKERS = [
  'Login expired',
  'Please run /login',
  'Invalid API key',
];

/**
 * Matched anywhere in the pane, but never sufficient on its own — the TUI
 * status line is not repainted while the session sits idle, so this outlives
 * the condition it describes.
 */
export const STATUS_LINE_MARKERS = ['Not logged in'];

// ── Credentials ─────────────────────────────────────────────────────────────

/** `claudeAiOauth` out of ~/.claude/.credentials.json. Times are epoch MS. */
export interface OauthBlock {
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  subscriptionType?: string;
}

export type CredentialVerdict =
  /** Both tokens valid. */
  | 'ok'
  /** Access token past expiry, refresh token still good. Normal for an idle
   *  session — Claude Code refreshes on demand, so this alone is not a wall. */
  | 'access_expired'
  /** Refresh token dead. Nothing but a human running `/login` fixes this. */
  | 'reauth_needed'
  /** No file, or no claudeAiOauth block in it. */
  | 'missing'
  /** File present but not parseable — measurement failure, not a verdict. */
  | 'unreadable';

export interface CredentialState {
  verdict: CredentialVerdict;
  /** Epoch ms, or null when unknown. */
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  /** Seconds until expiry; negative once past. Null when unknown. */
  accessExpiresInSec: number | null;
  refreshExpiresInSec: number | null;
  detail: string;
}

const MISSING: CredentialState = {
  verdict: 'missing',
  expiresAt: null,
  refreshTokenExpiresAt: null,
  accessExpiresInSec: null,
  refreshExpiresInSec: null,
  detail: 'no claudeAiOauth block in the credentials file',
};

/** Pure: parse the credentials file body against a clock. */
export function parseCredentials(raw: string | null, nowMs: number): CredentialState {
  if (raw === null) {
    return { ...MISSING, detail: 'credentials file not readable' };
  }

  let parsed: { claudeAiOauth?: OauthBlock };
  try {
    parsed = JSON.parse(raw) as { claudeAiOauth?: OauthBlock };
  } catch (err) {
    return {
      ...MISSING,
      verdict: 'unreadable',
      detail: `credentials file did not parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const oauth = parsed.claudeAiOauth;
  if (!oauth || typeof oauth !== 'object') return { ...MISSING };

  const expiresAt = numberOrNull(oauth.expiresAt);
  const refreshTokenExpiresAt = numberOrNull(oauth.refreshTokenExpiresAt);

  if (expiresAt === null && refreshTokenExpiresAt === null) {
    return { ...MISSING, detail: 'claudeAiOauth carries no expiry timestamps' };
  }

  const accessExpiresInSec =
    expiresAt === null ? null : Math.floor((expiresAt - nowMs) / 1000);
  const refreshExpiresInSec =
    refreshTokenExpiresAt === null ? null : Math.floor((refreshTokenExpiresAt - nowMs) / 1000);

  if (refreshExpiresInSec !== null && refreshExpiresInSec <= 0) {
    return {
      verdict: 'reauth_needed',
      expiresAt,
      refreshTokenExpiresAt,
      accessExpiresInSec,
      refreshExpiresInSec,
      detail:
        `refresh token expired ${-refreshExpiresInSec}s ago ` +
        `(${new Date(refreshTokenExpiresAt!).toISOString()}) — only /login clears this`,
    };
  }

  if (accessExpiresInSec !== null && accessExpiresInSec <= 0) {
    return {
      verdict: 'access_expired',
      expiresAt,
      refreshTokenExpiresAt,
      accessExpiresInSec,
      refreshExpiresInSec,
      detail: `access token expired ${-accessExpiresInSec}s ago; refresh token still valid`,
    };
  }

  return {
    verdict: 'ok',
    expiresAt,
    refreshTokenExpiresAt,
    accessExpiresInSec,
    refreshExpiresInSec,
    detail: `access token valid for ${accessExpiresInSec ?? '?'}s`,
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

// ── Pane parsing ────────────────────────────────────────────────────────────

/**
 * The canary's reply is everything after the LAST echo of the canary id: the
 * echo is the prompt line the watchdog itself typed, so anything below it is
 * what the session said back. Returns null when the echo is not in the pane,
 * which is the caller's signal to disregard the pane altogether.
 */
export function extractCanaryReply(pane: string, canaryId: string): string | null {
  const lines = pane.split('\n');
  let echoIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.includes(canaryId)) {
      echoIdx = i;
      break;
    }
  }
  if (echoIdx === -1) return null;
  return lines.slice(echoIdx + 1).join('\n');
}

function firstMatch(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return null;
}

// ── Assessment ──────────────────────────────────────────────────────────────

export type LoginWallTrigger =
  | 'canary_reply'
  | 'reauth_needed'
  | 'credentials_missing'
  | 'status_line';

export interface LoginWallEvidence {
  paneAvailable: boolean;
  canaryEchoFound: boolean;
  canaryReplyMarker: string | null;
  statusLineMarker: string | null;
  credentialVerdict: CredentialVerdict;
  credentialDetail: string;
  accessExpiresInSec: number | null;
  refreshExpiresInSec: number | null;
}

export interface LoginWallAssessment {
  /** True ⇒ do not restart, do not spend a breaker slot, page a human. */
  wall: boolean;
  trigger: LoginWallTrigger | null;
  reason: string;
  evidence: LoginWallEvidence;
}

export interface LoginWallInput {
  /** Pane text, or null when capture-pane failed. */
  pane: string | null;
  /** The id of the canary currently outstanding, or null if none. */
  canaryId: string | null;
  creds: CredentialState;
}

/**
 * Pure decision. Ordered most-specific first: direct evidence from the canary's
 * own reply beats inference from the credential file, which beats the status
 * line.
 */
export function assessLoginWall(input: LoginWallInput): LoginWallAssessment {
  const { pane, canaryId, creds } = input;

  const reply = pane !== null && canaryId !== null ? extractCanaryReply(pane, canaryId) : null;
  const canaryReplyMarker = reply === null ? null : firstMatch(reply, CANARY_REPLY_MARKERS);
  const statusLineMarker = pane === null ? null : firstMatch(pane, STATUS_LINE_MARKERS);

  const evidence: LoginWallEvidence = {
    paneAvailable: pane !== null,
    canaryEchoFound: reply !== null,
    canaryReplyMarker,
    statusLineMarker,
    credentialVerdict: creds.verdict,
    credentialDetail: creds.detail,
    accessExpiresInSec: creds.accessExpiresInSec,
    refreshExpiresInSec: creds.refreshExpiresInSec,
  };

  // 1. The canary itself was answered by the login wall. This is the 2026-09-17
  //    signature and the only evidence strong enough to stand alone.
  if (canaryReplyMarker !== null) {
    return {
      wall: true,
      trigger: 'canary_reply',
      reason: `canary ${canaryId} was answered by a login wall ("${canaryReplyMarker}")`,
      evidence,
    };
  }

  // 2. No usable pane evidence, but the credential file is terminal on its own:
  //    a dead refresh token cannot be refreshed, only re-issued by a human.
  if (creds.verdict === 'reauth_needed') {
    return { wall: true, trigger: 'reauth_needed', reason: creds.detail, evidence };
  }

  if (creds.verdict === 'missing') {
    return {
      wall: true,
      trigger: 'credentials_missing',
      reason: `no usable OAuth credentials on disk (${creds.detail})`,
      evidence,
    };
  }

  // 3. Status line says logged out. Weak on its own — it goes stale — so it
  //    only counts when the credentials corroborate it. If the tokens on disk
  //    are good, a restart genuinely might help (the session re-reads the file
  //    on start), so fall through and let the normal restart path run.
  if (statusLineMarker !== null && creds.verdict === 'access_expired') {
    return {
      wall: true,
      trigger: 'status_line',
      reason: `bridge status line reads "${statusLineMarker}" and ${creds.detail}`,
      evidence,
    };
  }

  return {
    wall: false,
    trigger: null,
    reason:
      statusLineMarker !== null
        ? `stale "${statusLineMarker}" marker in pane but credentials are usable (${creds.detail})`
        : `no login-wall evidence (${creds.detail})`,
    evidence,
  };
}

// ── Warn-ahead ──────────────────────────────────────────────────────────────

export interface ExpiryWarning {
  warn: boolean;
  /** Dedupe key — the expiry being warned about, so one token warns once. */
  refreshTokenExpiresAt: number | null;
  reason: string;
}

/**
 * The cheap pre-check: no pane scrape, just the credential file. Deliberately
 * keyed on the REFRESH token, because that is the one whose death needs a
 * human. An expired access token is routine — Claude Code refreshes it on the
 * next request — so alerting on it would page Jeff nightly for a non-event.
 */
export function assessExpiryWarning(
  creds: CredentialState,
  warnSec: number,
  alreadyWarnedFor: number | null,
): ExpiryWarning {
  const { refreshExpiresInSec, refreshTokenExpiresAt } = creds;

  if (refreshExpiresInSec === null || refreshTokenExpiresAt === null) {
    return { warn: false, refreshTokenExpiresAt, reason: 'no refresh-token expiry to check' };
  }
  if (refreshExpiresInSec > warnSec) {
    return {
      warn: false,
      refreshTokenExpiresAt,
      reason: `refresh token good for another ${refreshExpiresInSec}s`,
    };
  }
  if (alreadyWarnedFor === refreshTokenExpiresAt) {
    return { warn: false, refreshTokenExpiresAt, reason: 'already warned for this token' };
  }

  const when = new Date(refreshTokenExpiresAt).toISOString();
  return {
    warn: true,
    refreshTokenExpiresAt,
    reason:
      refreshExpiresInSec <= 0
        ? `refresh token expired at ${when} — the bridge needs /login`
        : `refresh token expires at ${when} (in ${Math.floor(refreshExpiresInSec / 3600)}h) — run /login on the bridge before then`,
  };
}

// ── I/O wrapper ─────────────────────────────────────────────────────────────

export interface LoginWallConfig {
  tmuxSession: string;
  credentialsFile: string;
  /** How many lines of scrollback to capture. */
  paneLines: number;
  execFn?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  readFileFn?: (p: string) => Promise<string>;
}

export class LoginWallDetector {
  private readonly config: LoginWallConfig;
  private readonly exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  private readonly readFile: (p: string) => Promise<string>;

  constructor(config: LoginWallConfig) {
    this.config = config;
    this.exec = config.execFn ?? execDefault;
    this.readFile = config.readFileFn ?? ((p: string) => fs.readFile(p, 'utf8'));
  }

  /** Null when the pane cannot be read — treated as "no pane evidence". */
  async capturePane(): Promise<string | null> {
    const session = this.config.tmuxSession.replace(/'/g, `'\\''`);
    const cmd = `tmux capture-pane -p -S -${this.config.paneLines} -t '${session}'`;
    try {
      const { stdout } = await this.exec(cmd);
      return stdout;
    } catch {
      return null;
    }
  }

  async readCredentials(nowMs: number = Date.now()): Promise<CredentialState> {
    try {
      return parseCredentials(await this.readFile(this.config.credentialsFile), nowMs);
    } catch {
      return parseCredentials(null, nowMs);
    }
  }

  async check(canaryId: string | null, nowMs: number = Date.now()): Promise<LoginWallAssessment> {
    const [pane, creds] = await Promise.all([this.capturePane(), this.readCredentials(nowMs)]);
    return assessLoginWall({ pane, canaryId, creds });
  }
}

/** The id CanarySender types into the pane, rebuilt from the recorded send time. */
export function canaryIdFor(canarySentAt: number | null): string | null {
  return canarySentAt === null ? null : `watchdog-canary-${canarySentAt}`;
}
