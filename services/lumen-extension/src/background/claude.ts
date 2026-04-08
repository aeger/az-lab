// Lumen's reasoning engine — Ollama (local, free) + Wren delegation for complex tasks

import { getConfig, AGENT_DISPLAY_NAME, STORAGE_KEYS } from '../shared/config';
import type { ChatMessage, PageContext } from '../shared/types';
import { createTask } from './supabase';

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
  if (chatHistory.length > 50) {
    chatHistory = chatHistory.slice(-50);
  }
  await chrome.storage.local.set({ lumen_chat_history: chatHistory });
}

// --- Chat via Ollama (default, free, local) ---

async function chatOllama(
  messages: { role: string; content: string }[],
  systemPrompt: string
): Promise<string> {
  const config = await getConfig();
  const url = `${config.ollamaUrl}/api/chat`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollamaModel,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.message?.content ?? 'No response';
}

// --- Chat via Anthropic API (optional, if key provided) ---

async function chatAnthropic(
  messages: { role: string; content: string }[],
  systemPrompt: string
): Promise<string> {
  const config = await getConfig();
  if (!config.anthropicApiKey) throw new Error('No Anthropic API key configured');

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

  if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`);

  const data = await response.json();
  return data.content?.[0]?.text ?? 'No response';
}

// --- Delegate to Wren via task queue (for complex/long tasks) ---

export async function delegateToWren(
  description: string,
  context: Record<string, unknown> = {}
): Promise<string> {
  const created = await createTask({
    title: `Lumen delegation: ${description.slice(0, 60)}`,
    description,
    target: 'wren',
    priority: 2,
    tags: ['lumen', 'delegated'],
    context: { ...context, delegated_by: 'lumen' },
  });

  const taskId = created[0]?.id;
  return taskId
    ? `Delegated to Wren (task ${taskId.slice(0, 8)}). He'll pick it up within 5 minutes — I'll check back.`
    : 'Task queued to Wren.';
}

// --- Main chat function ---

export async function chat(
  userMessage: string,
  pageContext?: PageContext
): Promise<ChatMessage> {
  const config = await getConfig();

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

  // Build messages
  const messages = chatHistory.map((msg) => ({
    role: msg.role as 'user' | 'assistant',
    content: msg.role === 'user' && msg.pageContext
      ? `${msg.content}\n\n[Page: ${msg.pageContext.title} — ${msg.pageContext.url}]${msg.pageContext.selection ? `\n[Selection: ${msg.pageContext.selection}]` : ''}`
      : msg.content,
  }));

  try {
    let content: string;

    // Pick backend: Anthropic API if key provided, otherwise Ollama (free)
    if (config.anthropicApiKey) {
      content = await chatAnthropic(messages, systemPrompt);
    } else {
      content = await chatOllama(messages, systemPrompt);
    }

    const assistantMsg: ChatMessage = { role: 'assistant', content, timestamp: Date.now() };
    chatHistory.push(assistantMsg);
    await saveChatHistory();
    return assistantMsg;
  } catch (error) {
    const errContent = error instanceof Error ? error.message : 'Unknown error';

    // If Ollama fails, provide helpful guidance
    let fallbackMsg = `Error: ${errContent}`;
    if (errContent.includes('Ollama') || errContent.includes('Failed to fetch')) {
      fallbackMsg = `Can't reach Ollama at ${config.ollamaUrl}. Make sure Ollama is running on svc-podman-01 with a chat model pulled (e.g. \`ollama pull llama3.1:8b\`). Or set an Anthropic API key in Settings as a fallback.`;
    }

    const errMsg: ChatMessage = { role: 'assistant', content: fallbackMsg, timestamp: Date.now() };
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
