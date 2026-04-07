// Lumen content script — page context extraction and selection tracking

import type { PageContext } from '../shared/types';

function getPageContext(): PageContext {
  const selection = window.getSelection()?.toString()?.trim();
  const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? undefined;

  return {
    url: window.location.href,
    title: document.title,
    selection: selection || undefined,
    metaDescription: metaDesc,
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
