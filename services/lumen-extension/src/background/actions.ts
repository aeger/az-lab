// Permissioned browser-action runner.
//
// Flow for a single tool_use block emitted by the model:
//   1. Resolve the active tab the action will run against.
//   2. Check session/page-scoped allow-list — auto-allow if matched.
//      browser_read_dom is auto-allowed (read-only).
//   3. Otherwise broadcast PERMISSION_REQUEST to the side panel and wait for
//      a PERMISSION_RESPONSE matching this action's id.
//   4. On allow: dispatch to content script (or chrome.tabs for navigate),
//      append to the action log, return the result string. On deny: throw.
//
// All approved/denied/auto-allowed actions are appended to chrome.storage.local
// for an auditable trail. Session-scoped permissions live in chrome.storage.session
// (cleared on browser restart).

import { STORAGE_KEYS } from '../shared/config';
import type {
  ActionLogEntry,
  BrowserActionName,
  PendingAction,
  PermissionDecision,
} from '../shared/browser-actions';
import { describeAction } from '../shared/browser-actions';

const PERMISSION_TIMEOUT_MS = 120_000;
const ACTION_LOG_MAX = 100;

interface PendingResolver {
  resolve: (decision: PermissionDecision['decision']) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingPermissions = new Map<string, PendingResolver>();

// --- Session permission cache (in-memory mirror for fast checks) ----

interface SessionPermissions {
  // key format: `${name}|${host}` for host-scoped, `${name}|*` for session-scoped
  allowed: Record<string, true>;
}

async function loadSessionPerms(): Promise<SessionPermissions> {
  // chrome.storage.session clears on browser restart — perfect scope.
  const store = (chrome.storage as any).session ?? chrome.storage.local;
  const data = await store.get(STORAGE_KEYS.sessionPermissions);
  return data[STORAGE_KEYS.sessionPermissions] ?? { allowed: {} };
}

async function saveSessionPerms(perms: SessionPermissions): Promise<void> {
  const store = (chrome.storage as any).session ?? chrome.storage.local;
  await store.set({ [STORAGE_KEYS.sessionPermissions]: perms });
}

export async function clearSessionPermissions(): Promise<void> {
  await saveSessionPerms({ allowed: {} });
}

function permKey(name: BrowserActionName, host: string | '*'): string {
  return `${name}|${host}`;
}

async function isAutoAllowed(name: BrowserActionName, host: string): Promise<boolean> {
  if (name === 'browser_read_dom') return true; // read-only — never gated
  const perms = await loadSessionPerms();
  return Boolean(perms.allowed[permKey(name, host)] || perms.allowed[permKey(name, '*')]);
}

async function recordScope(decision: PermissionDecision['decision'], name: BrowserActionName, host: string): Promise<void> {
  if (decision !== 'allow_page' && decision !== 'allow_session') return;
  const perms = await loadSessionPerms();
  const host_ = decision === 'allow_page' ? host : '*';
  perms.allowed[permKey(name, host_)] = true;
  await saveSessionPerms(perms);
}

// --- Permission request bridge ---------------------------------

export function resolvePermission(actionId: string, decision: PermissionDecision['decision']): void {
  const pending = pendingPermissions.get(actionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingPermissions.delete(actionId);
  pending.resolve(decision);
}

async function requestPermission(action: PendingAction): Promise<PermissionDecision['decision']> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(action.id);
      resolve('deny');
    }, PERMISSION_TIMEOUT_MS);
    pendingPermissions.set(action.id, { resolve, timer });

    // Broadcast to any open extension page (side panel). Failure is fine — if
    // no listener is open, the timeout will resolve as 'deny'.
    chrome.runtime
      .sendMessage({ type: 'PERMISSION_REQUEST', payload: action })
      .catch(() => { /* no listener — let timeout deny */ });
  });
}

// --- Action log -------------------------------------------------

async function appendLog(entry: ActionLogEntry): Promise<void> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.actionLog);
  const log: ActionLogEntry[] = stored[STORAGE_KEYS.actionLog] ?? [];
  log.unshift(entry);
  if (log.length > ACTION_LOG_MAX) log.length = ACTION_LOG_MAX;
  await chrome.storage.local.set({ [STORAGE_KEYS.actionLog]: log });
  chrome.runtime.sendMessage({ type: 'ACTION_LOG_ENTRY', payload: entry }).catch(() => {});
}

export async function getActionLog(): Promise<ActionLogEntry[]> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.actionLog);
  return stored[STORAGE_KEYS.actionLog] ?? [];
}

// --- Dispatch ---------------------------------------------------

interface ContentExecResult {
  ok: boolean;
  result?: string;
  error?: string;
}

async function dispatchToTab(tabId: number, name: BrowserActionName, input: Record<string, unknown>): Promise<string> {
  // browser_navigate uses chrome.tabs.update — it would race the content script
  // off the page anyway. Everything else goes through the content script.
  if (name === 'browser_navigate') {
    const url = String(input.url);
    if (!/^https?:\/\//i.test(url)) throw new Error('navigate URL must be http(s)');
    await chrome.tabs.update(tabId, { url });
    return `navigation requested to ${url}`;
  }
  const response = (await chrome.tabs.sendMessage(tabId, {
    type: 'EXEC_BROWSER_ACTION',
    payload: { name, input },
  })) as ContentExecResult | undefined;
  if (!response) throw new Error('content script returned no response (page may not be loaded)');
  if (!response.ok) throw new Error(response.error || 'unknown content-script error');
  return response.result ?? 'ok';
}

export interface ToolUseRequest {
  id: string;        // tool_use id from Claude
  name: BrowserActionName;
  input: Record<string, unknown>;
}

export interface ToolUseResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// Execute one tool_use block end-to-end: permission gate -> dispatch -> log.
// Returns a tool_result block ready to attach to the next API turn.
export async function runToolUse(req: ToolUseRequest): Promise<ToolUseResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return {
      tool_use_id: req.id,
      content: 'error: no active tab',
      is_error: true,
    };
  }
  const host = safeHost(tab.url);
  const action: PendingAction = {
    id: req.id,
    name: req.name,
    input: req.input,
    origin: host,
    tabId: tab.id,
    url: tab.url,
    timestamp: Date.now(),
  };

  let outcome: ActionLogEntry['outcome'];
  let resultStr = '';
  let error: string | undefined;

  try {
    const autoAllow = await isAutoAllowed(req.name, host);
    if (autoAllow) {
      outcome = 'auto_allowed';
    } else {
      const decision = await requestPermission(action);
      if (decision === 'deny') {
        outcome = 'denied';
        await appendLog({ ...action, outcome, result: `denied: ${describeAction(req.name, req.input)}` });
        return {
          tool_use_id: req.id,
          content: `User denied: ${describeAction(req.name, req.input)}. Do NOT retry the same action; ask the user what they want instead.`,
          is_error: true,
        };
      }
      await recordScope(decision, req.name, host);
      outcome = 'allowed';
    }
    resultStr = await dispatchToTab(tab.id, req.name, req.input);
    await appendLog({ ...action, outcome, result: resultStr });
    return { tool_use_id: req.id, content: resultStr };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    await appendLog({ ...action, outcome: 'error', error });
    return { tool_use_id: req.id, content: `error: ${error}`, is_error: true };
  }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return 'unknown'; }
}
