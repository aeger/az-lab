// Browser-action tool definitions for Lumen's permissioned page interaction.
// These tool schemas are passed to Claude via Agent Bus /chat. When the model
// emits a `tool_use` block, the background runs a permission gate, dispatches
// the action to the active tab's content script, and returns the result as a
// `tool_result` block in the next API turn.

export const BROWSER_TOOLS = [
  {
    name: 'browser_click',
    description:
      'Click an element on the current page. Requires explicit user approval. ' +
      'Use a CSS selector that uniquely targets the element (prefer id, then data-*, then role + text).',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector targeting the element to click' },
        reason: { type: 'string', description: 'Short reason for the click, shown to the user in the permission prompt' },
      },
      required: ['selector', 'reason'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input, textarea, or contenteditable element on the current page. ' +
      'Requires explicit user approval. Replaces existing value by default.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector targeting the input element' },
        text: { type: 'string', description: 'Text to type into the field' },
        append: { type: 'boolean', description: 'If true, append to existing value instead of replacing' },
        reason: { type: 'string', description: 'Short reason shown in the permission prompt' },
      },
      required: ['selector', 'text', 'reason'],
    },
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the current page. Either to a CSS-selector target, to "top"/"bottom", or by a pixel delta.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector — scrolls that element into view' },
        position: { type: 'string', enum: ['top', 'bottom'], description: 'Scroll to top or bottom of page' },
        delta: { type: 'number', description: 'Pixels to scroll relative to current position (positive=down)' },
        reason: { type: 'string', description: 'Short reason shown in the permission prompt' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate the active tab to a URL. Requires explicit user approval.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL to navigate to' },
        reason: { type: 'string', description: 'Short reason shown in the permission prompt' },
      },
      required: ['url', 'reason'],
    },
  },
  {
    name: 'browser_read_dom',
    description:
      'Read text content of one or more elements on the current page. Read-only — does not modify the page. ' +
      'Useful to inspect a specific element before clicking or typing.',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to read. Returns up to 5 matches.' },
        attribute: { type: 'string', description: 'Optional attribute name to read instead of text (e.g. "href")' },
      },
      required: ['selector'],
    },
  },
] as const;

export type BrowserActionName =
  | 'browser_click'
  | 'browser_type'
  | 'browser_scroll'
  | 'browser_navigate'
  | 'browser_read_dom';

export type BrowserActionInput =
  | { name: 'browser_click'; input: { selector: string; reason: string } }
  | { name: 'browser_type'; input: { selector: string; text: string; reason: string; append?: boolean } }
  | { name: 'browser_scroll'; input: { selector?: string; position?: 'top' | 'bottom'; delta?: number; reason: string } }
  | { name: 'browser_navigate'; input: { url: string; reason: string } }
  | { name: 'browser_read_dom'; input: { selector: string; attribute?: string } };

export interface PendingAction {
  id: string;             // tool_use id from Claude — used to correlate result
  name: BrowserActionName;
  input: Record<string, unknown>;
  origin: string;         // hostname of the tab the action will run against
  tabId: number;
  url: string;
  timestamp: number;
}

export type PermissionDecision =
  | { decision: 'allow' }
  | { decision: 'allow_page' }       // remember for this hostname for the session
  | { decision: 'allow_session' }    // remember for any host for the session
  | { decision: 'deny' };

export interface ActionLogEntry {
  id: string;
  name: BrowserActionName;
  input: Record<string, unknown>;
  origin: string;
  url: string;
  timestamp: number;
  outcome: 'allowed' | 'denied' | 'auto_allowed' | 'error';
  result?: string;
  error?: string;
}

// Human-readable summary used in the permission prompt.
export function describeAction(name: BrowserActionName, input: Record<string, unknown>): string {
  switch (name) {
    case 'browser_click':
      return `click ${String(input.selector)}`;
    case 'browser_type': {
      const t = String(input.text ?? '');
      const preview = t.length > 60 ? t.slice(0, 60) + '…' : t;
      return `type "${preview}" into ${String(input.selector)}`;
    }
    case 'browser_scroll':
      if (input.selector) return `scroll to ${String(input.selector)}`;
      if (input.position) return `scroll to ${String(input.position)}`;
      if (input.delta !== undefined) return `scroll by ${String(input.delta)}px`;
      return 'scroll the page';
    case 'browser_navigate':
      return `navigate to ${String(input.url)}`;
    case 'browser_read_dom':
      return `read ${String(input.selector)}`;
  }
}
