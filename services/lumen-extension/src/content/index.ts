// Lumen content script — page context extraction and selection tracking

import type { PageContext } from '../shared/types';

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
  }
  return false;
});

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
