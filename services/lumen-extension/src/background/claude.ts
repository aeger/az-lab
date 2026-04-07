// Claude API integration — Lumen's reasoning engine

import { getConfig, AGENT_NAME, AGENT_DISPLAY_NAME, STORAGE_KEYS } from '../shared/config';
import type { ChatMessage, PageContext } from '../shared/types';

const SYSTEM_PROMPT = `You are ${AGENT_DISPLAY_NAME}, a browser-native agent in Jeff's az-lab agentic system.

Your role: Eyes on the internet. You live in Jeff's Edge browser and can see what he's browsing,
extract page context, search his shared memory, manage tasks, and coordinate with the other agents.

Team:
- Wren = Claude Code (svc-podman-01 server)
- Iris = Cowork (claude.ai web)
- Atlas = Claude Desktop (Windows)
- Forge = Claude Code Desktop
- Volt = Nemotron 120B (nemoclaw-01)
- Hermes = Agent Bus (port 8765)
- You = ${AGENT_DISPLAY_NAME} (Edge browser extension)

You have access to:
- Shared Supabase memory (azlab-memory project)
- Memory MCP server (semantic search, decay scoring)
- Agent Bus (Discord, triggers)
- The current page the user is viewing

Behavioral rules (loaded from feedback memories):
{FEEDBACK_RULES}

Be concise. Be helpful. Don't ask for confirmation on things Jeff already told you to do.
When you need server-side work done, delegate to Wren via the task queue.`;

// Chat history (in-memory, persisted to storage)
let chatHistory: ChatMessage[] = [];

export async function loadChatHistory(): Promise<ChatMessage[]> {
  const stored = await chrome.storage.local.get('lumen_chat_history');
  chatHistory = stored.lumen_chat_history ?? [];
  return chatHistory;
}

async function saveChatHistory(): Promise<void> {
  // Keep last 50 messages
  if (chatHistory.length > 50) {
    chatHistory = chatHistory.slice(-50);
  }
  await chrome.storage.local.set({ lumen_chat_history: chatHistory });
}

export async function chat(
  userMessage: string,
  pageContext?: PageContext
): Promise<ChatMessage> {
  const config = await getConfig();

  if (!config.anthropicApiKey) {
    return {
      role: 'assistant',
      content: 'I need an Anthropic API key to chat. Open my options page (right-click extension icon > Options) to configure it.',
      timestamp: Date.now(),
    };
  }

  // Build user message with page context
  let fullMessage = userMessage;
  if (pageContext) {
    fullMessage += `\n\n[Current page: ${pageContext.title} — ${pageContext.url}]`;
    if (pageContext.selection) {
      fullMessage += `\n[Selected text: ${pageContext.selection}]`;
    }
  }

  // Add to history
  const userMsg: ChatMessage = {
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
    pageContext,
  };
  chatHistory.push(userMsg);

  // Load feedback rules
  const stored = await chrome.storage.local.get(STORAGE_KEYS.feedbackMemories);
  const feedbackRules = (stored[STORAGE_KEYS.feedbackMemories] ?? []).join('\n\n');
  const systemPrompt = SYSTEM_PROMPT.replace('{FEEDBACK_RULES}', feedbackRules || '(none loaded yet — run startup)');

  // Build messages for API
  const messages = chatHistory.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.role === 'user' && msg.pageContext
      ? `${msg.content}\n\n[Page: ${msg.pageContext.title} — ${msg.pageContext.url}]${msg.pageContext.selection ? `\n[Selection: ${msg.pageContext.selection}]` : ''}`
      : msg.content,
  }));

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${err}`);
    }

    const data = await response.json();
    const assistantContent = data.content?.[0]?.text ?? 'No response';

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: assistantContent,
      timestamp: Date.now(),
    };
    chatHistory.push(assistantMsg);
    await saveChatHistory();

    return assistantMsg;
  } catch (error) {
    const errMsg: ChatMessage = {
      role: 'assistant',
      content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      timestamp: Date.now(),
    };
    chatHistory.push(errMsg);
    await saveChatHistory();
    return errMsg;
  }
}

export function getChatHistory(): ChatMessage[] {
  return chatHistory;
}

export async function clearChatHistory(): Promise<void> {
  chatHistory = [];
  await chrome.storage.local.remove('lumen_chat_history');
}
