// Lumen content script — page context extraction, selection tracking,
// and execution of permissioned browser actions dispatched by the background.

import type { PageContext } from '../shared/types';
import type { BrowserActionName } from '../shared/browser-actions';

// Cap injected page text so we don't blow the chat context window.
const MAX_PAGE_TEXT = 12000;

function getPageContext(): PageContext {
  const selection = window.getSelection()?.toString()?.trim();
  const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? undefined;

  // Visible page text — collapse whitespace, trim, truncate. Lets Lumen actually
  // read what's on the page (not just the title/URL).
  const raw = (document.body?.innerText ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const text = raw
    ? (raw.length > MAX_PAGE_TEXT ? raw.slice(0, MAX_PAGE_TEXT) + '\n…[truncated]' : raw)
    : undefined;

  return {
    url: window.location.href,
    title: document.title,
    selection: selection || undefined,
    metaDescription: metaDesc,
    text,
    tabId: 0, // filled in by background
  };
}

// Respond to background requests for page context
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_PAGE_CONTEXT') {
    sendResponse(getPageContext());
    return false;
  }
  if (message.type === 'EXEC_BROWSER_ACTION') {
    executeAction(message.payload.name, message.payload.input)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async
  }
  return false;
});

// --- Permissioned action executor ---------------------------------

const READ_DOM_MAX = 4000;
const READ_DOM_MAX_MATCHES = 5;

async function executeAction(name: BrowserActionName, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'browser_click':       return doClick(String(input.selector));
    case 'browser_type':        return doType(String(input.selector), String(input.text), Boolean(input.append));
    case 'browser_scroll':      return doScroll(input.selector as string | undefined, input.position as 'top' | 'bottom' | undefined, input.delta as number | undefined);
    case 'browser_read_dom':    return doReadDom(String(input.selector), input.attribute as string | undefined);
    // browser_navigate is handled by the background script (uses chrome.tabs API)
    default: throw new Error(`unsupported content-side action: ${name}`);
  }
}

function findOne(selector: string): HTMLElement {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`no element matches selector: ${selector}`);
  if (!(el instanceof HTMLElement)) throw new Error(`selector matched non-HTMLElement: ${selector}`);
  return el;
}

async function doClick(selector: string): Promise<string> {
  const el = findOne(selector);
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  el.click();
  return `clicked ${describeEl(el)}`;
}

async function doType(selector: string, text: string, append: boolean): Promise<string> {
  const el = findOne(selector);
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const tag = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(tag, 'value')?.set;
    const next = append ? `${el.value}${text}` : text;
    if (setter) setter.call(el, next); else el.value = next;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return `typed ${text.length} chars into ${describeEl(el)}`;
  }

  if (el.isContentEditable) {
    if (!append) el.textContent = '';
    document.execCommand('insertText', false, text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return `typed ${text.length} chars into contenteditable ${describeEl(el)}`;
  }

  throw new Error(`element is not typable: ${describeEl(el)}`);
}

async function doScroll(selector: string | undefined, position: 'top' | 'bottom' | undefined, delta: number | undefined): Promise<string> {
  if (selector) {
    const el = findOne(selector);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return `scrolled ${describeEl(el)} into view`;
  }
  if (position === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return 'scrolled to top'; }
  if (position === 'bottom') { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); return 'scrolled to bottom'; }
  if (typeof delta === 'number') { window.scrollBy({ top: delta, behavior: 'smooth' }); return `scrolled by ${delta}px`; }
  throw new Error('scroll requires selector, position, or delta');
}

async function doReadDom(selector: string, attribute?: string): Promise<string> {
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, READ_DOM_MAX_MATCHES);
  if (nodes.length === 0) throw new Error(`no element matches selector: ${selector}`);
  const parts = nodes.map((n, i) => {
    let value: string;
    if (attribute) value = (n as Element).getAttribute(attribute) ?? '';
    else value = (n as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? '';
    if (value.length > READ_DOM_MAX) value = value.slice(0, READ_DOM_MAX) + '…[truncated]';
    return nodes.length > 1 ? `[${i}] ${value}` : value;
  });
  return parts.join('\n');
}

function describeEl(el: HTMLElement): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.')}` : '';
  return `<${el.tagName.toLowerCase()}${id}${cls}>`;
}

// Track selection changes for "Ask Lumen about this" context menu
let selectionTimeout: ReturnType<typeof setTimeout>;
document.addEventListener('selectionchange', () => {
  clearTimeout(selectionTimeout);
  selectionTimeout = setTimeout(() => {
    const text = window.getSelection()?.toString()?.trim();
    if (text && text.length > 5) {
      chrome.runtime.sendMessage({
        type: 'SELECTION_CHANGED',
        payload: { text, url: window.location.href },
      }).catch(() => {}); // background may not be listening
    }
  }, 500);
});
