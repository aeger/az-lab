// Lumen service worker — background entry point

import { AGENT_NAME, ALARMS, STORAGE_KEYS } from '../shared/config';
import type { LumenMessage, BackgroundResponse } from '../shared/messages';
import type { AgentStatus, SoundPrefs, DEFAULT_SOUND_PREFS, SentinelNotification } from '../shared/types';
import { runStartup } from './startup';
import { chat, loadChatHistory, getChatHistory } from './claude';
import { mcpHealthCheck } from './mcp-client';
import { searchMemoriesKeyword, fetchPendingTasks, fetchTasks, createTask, upsertMemory } from './supabase';
import { busHealthCheck } from './agent-bus';
import { fetchSentinelNotifications, markSentinelRead, markAllSentinelRead } from './sentinel';

// In-memory notification cache for this session
let cachedNotifications: SentinelNotification[] = [];
let lastNotifCheck = 0;

let agentStatus: AgentStatus = {
  memoryMcp: 'disconnected',
  supabase: 'disconnected',
  agentBus: 'disconnected',
  anthropic: 'missing_key',
};

// --- Install & Startup ---

chrome.runtime.onInstalled.addListener(async () => {
  console.log(`[${AGENT_NAME}] Extension installed`);

  // Set up side panel behavior — open on action click
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

  // Create context menu
  chrome.contextMenus.create({
    id: 'lumen-save-selection',
    title: 'Save to Lumen memory',
    contexts: ['selection'],
  });

  chrome.contextMenus.create({
    id: 'lumen-ask-about',
    title: 'Ask Lumen about this',
    contexts: ['selection'],
  });

  // Set up periodic alarms
  chrome.alarms.create(ALARMS.heartbeat, { periodInMinutes: 2 });
  chrome.alarms.create(ALARMS.taskPoll, { periodInMinutes: 5 });
  chrome.alarms.create(ALARMS.notifPoll, { periodInMinutes: 2 });

  // Run startup
  const result = await runStartup();
  agentStatus = result.status;
});

chrome.runtime.onStartup.addListener(async () => {
  console.log(`[${AGENT_NAME}] Browser started`);
  await loadChatHistory();
  const result = await runStartup();
  agentStatus = result.status;
});

// --- Alarms ---

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARMS.heartbeat) {
    // Lightweight connectivity check
    const [mcpOk, busOk] = await Promise.allSettled([
      mcpHealthCheck(),
      busHealthCheck(),
    ]);
    agentStatus.memoryMcp = (mcpOk.status === 'fulfilled' && mcpOk.value) ? 'connected' : 'disconnected';
    agentStatus.agentBus = (busOk.status === 'fulfilled' && busOk.value) ? 'connected' : 'disconnected';
  }

  if (alarm.name === ALARMS.taskPoll) {
    // Check for tasks targeting lumen
    try {
      const tasks = await fetchPendingTasks();
      const myTasks = tasks.filter(t => t.target === 'lumen' || t.target === 'any');
      if (myTasks.length > 0) {
        chrome.action.setBadgeText({ text: String(myTasks.length) });
        chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      } else {
        chrome.action.setBadgeText({ text: '' });
      }
    } catch {
      // Supabase unreachable — silent
    }
  }

  if (alarm.name === ALARMS.notifPoll) {
    await pollSentinelNotifications();
  }
});

// --- Context Menu ---

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!info.selectionText || !tab?.id) return;

  if (info.menuItemId === 'lumen-save-selection') {
    const name = `Web clip — ${tab.title?.slice(0, 50) ?? 'untitled'}`;
    try {
      await upsertMemory({
        name,
        type: 'reference',
        description: `Clipped from ${info.pageUrl ?? tab.url ?? 'unknown page'}`,
        content: info.selectionText,
        tags: ['web-clip', 'lumen'],
        source: 'lumen',
      });
      // Brief notification via badge
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);
    } catch (err) {
      console.error(`[${AGENT_NAME}] Failed to save clip:`, err);
    }
  }

  if (info.menuItemId === 'lumen-ask-about') {
    // Open side panel and send the selection as a question
    chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    // The sidepanel will pick up the selection via content script
  }
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((message: LumenMessage, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse);
  return true; // async response
});

async function handleMessage(message: LumenMessage): Promise<BackgroundResponse> {
  switch (message.type) {
    case 'GET_STATUS':
      return { type: 'STATUS', payload: agentStatus };

    case 'GET_CHAT_HISTORY':
      return { type: 'CHAT_HISTORY', payload: getChatHistory() };

    case 'CHAT_SEND': {
      // Get page context from active tab if requested
      let pageContext;
      if (message.payload.includePageContext) {
        try {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) {
            const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_CONTEXT' });
            pageContext = response;
          }
        } catch { /* content script not loaded */ }
      }

      const reply = await chat(message.payload.message, pageContext);
      return { type: 'CHAT_RESPONSE', payload: reply };
    }

    case 'MEMORY_SEARCH': {
      try {
        const results = await searchMemoriesKeyword(message.payload.query);
        return { type: 'MEMORY_RESULTS', payload: results };
      } catch (err) {
        return { type: 'ERROR', payload: { message: String(err) } };
      }
    }

    case 'MEMORY_STORE': {
      try {
        await upsertMemory({
          name: message.payload.name,
          type: message.payload.type,
          description: message.payload.description,
          content: message.payload.content,
          tags: message.payload.tags,
          source: 'lumen',
        });
        return { type: 'MEMORY_STORED', payload: { success: true } };
      } catch (err) {
        return { type: 'MEMORY_STORED', payload: { success: false, error: String(err) } };
      }
    }

    case 'TASK_LIST': {
      try {
        const tasks = await fetchTasks(message.payload?.status);
        return { type: 'TASK_RESULTS', payload: tasks };
      } catch (err) {
        return { type: 'ERROR', payload: { message: String(err) } };
      }
    }

    case 'TASK_CREATE': {
      try {
        const created = await createTask({
          title: message.payload.title,
          description: message.payload.description,
          target: message.payload.target,
          priority: message.payload.priority,
          tags: message.payload.tags,
        });
        return { type: 'TASK_CREATED', payload: { success: true, id: created[0]?.id } };
      } catch (err) {
        return { type: 'TASK_CREATED', payload: { success: false, error: String(err) } };
      }
    }

    case 'OPEN_SIDEPANEL': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
      return { type: 'STATUS', payload: agentStatus };
    }

    case 'RUN_STARTUP': {
      const result = await runStartup();
      agentStatus = result.status;
      return { type: 'STATUS', payload: agentStatus };
    }

    case 'PAGE_CONTEXT':
    case 'SELECTION_CHANGED':
      // Stored for next chat message
      return { type: 'STATUS', payload: agentStatus };

    case 'NOTIF_LIST': {
      try {
        const status = (message as any).payload?.status;
        const limit = (message as any).payload?.limit || 50;
        const data = await fetchSentinelNotifications(status, limit);
        cachedNotifications = data.notifications;
        return { type: 'NOTIF_RESULTS', payload: data } as any;
      } catch (err) {
        // Return cached on failure
        const unreadCount = cachedNotifications.filter(n => n.status === 'unread').length;
        const criticalCount = cachedNotifications.filter(n => n.status === 'unread' && n.urgency === 'critical').length;
        return { type: 'NOTIF_RESULTS', payload: { notifications: cachedNotifications, unreadCount, criticalCount } } as any;
      }
    }

    case 'NOTIF_READ': {
      const id = (message as any).payload?.id;
      if (id) {
        await markSentinelRead(id).catch(() => {});
        cachedNotifications = cachedNotifications.map(n =>
          n.id === id ? { ...n, status: 'read' as const } : n
        );
      }
      return { type: 'STATUS', payload: agentStatus };
    }

    case 'NOTIF_READ_ALL': {
      await markAllSentinelRead().catch(() => {});
      cachedNotifications = cachedNotifications.map(n => ({ ...n, status: 'read' as const }));
      return { type: 'STATUS', payload: agentStatus };
    }

    case 'GET_SOUND_PREFS': {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.soundPrefs);
      return { type: 'SOUND_PREFS', payload: stored[STORAGE_KEYS.soundPrefs] ?? {} } as any;
    }

    case 'SET_SOUND_PREFS': {
      await chrome.storage.local.set({ [STORAGE_KEYS.soundPrefs]: (message as any).payload });
      return { type: 'STATUS', payload: agentStatus };
    }

    case 'NOTIF_SOUND_TEST': {
      // Sound test must play in the sidepanel (Web Audio), just ack here
      return { type: 'STATUS', payload: agentStatus };
    }

    default:
      return { type: 'ERROR', payload: { message: 'Unknown message type' } };
  }
}

// --- Sentinel notification polling ---

async function pollSentinelNotifications(): Promise<void> {
  try {
    const data = await fetchSentinelNotifications('unread', 20);
    const newNotifs = data.notifications.filter(n =>
      !cachedNotifications.some(c => c.id === n.id)
    );

    if (newNotifs.length === 0) {
      cachedNotifications = data.notifications;
      return;
    }

    // Update badge
    if (data.unreadCount > 0) {
      const badgeColor = data.criticalCount > 0 ? '#ef4444' : '#f97316';
      chrome.action.setBadgeText({ text: String(data.unreadCount) });
      chrome.action.setBadgeBackgroundColor({ color: badgeColor });
    }

    // Fire native Chrome notifications for new critical/high items
    const stored = await chrome.storage.local.get(STORAGE_KEYS.soundPrefs);
    const soundPrefs = stored[STORAGE_KEYS.soundPrefs] ?? {};

    for (const n of newNotifs.slice(0, 5)) {  // cap at 5 native notifs per poll
      if (n.urgency !== 'critical' && n.urgency !== 'high') continue;

      chrome.notifications.create(`sentinel:${n.id}`, {
        type: 'basic',
        iconUrl: 'icons/lumen-48.png',
        title: n.title,
        message: n.body?.slice(0, 150) || n.category,
        priority: n.urgency === 'critical' ? 2 : 1,
        requireInteraction: n.urgency === 'critical',
      });
    }

    cachedNotifications = data.notifications;
    lastNotifCheck = Date.now();
  } catch {
    // Sentinel offline — silent
  }
}
