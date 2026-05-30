// Claude integration — routes through Agent Bus (no API key in browser)

import { getConfig, AGENT_DISPLAY_NAME, STORAGE_KEYS } from '../shared/config';
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

IMPORTANT — your actual capabilities in this chat:
You are a TEXT-ONLY assistant. You do NOT have live tools in this chat panel. You cannot
run queries, search memory, or fetch the task list yourself from within a reply. The Lumen
extension UI handles live data in its own tabs:
- The **Tasks** tab reads the \`task_queue\` Postgres table directly (statuses like ready,
  in_progress, review_needed, blocked, paused, completed). That is where tasks live and are shown.
- The **Memory** tab and context-menu "Save to Lumen memory" handle the shared Supabase
  \`memories\` table (types: episodic, feedback, project, reference, semantic, user).

Hard rules — these prevent the failure Jeff has seen:
1. NEVER output tool-call JSON, function-call syntax, or code blocks (e.g. {"query":"type:task"})
   as your reply. You have no tool to execute them — emitting them just confuses the user. Answer
   in plain language.
2. Tasks are NOT memories. There is no \`type:task\` memory. Never search memory for tasks and
   never claim "there are no tasks in the system" — you cannot see the task table from chat. If
   asked about tasks, tell the user to open the **Tasks** tab (which queries \`task_queue\`), and
   that there are typically hundreds of rows there.
3. If you cannot directly do something from chat, say so plainly and point to the right tab or to
   Wren — do NOT fabricate a result.

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

export async function chat(
  userMessage: string,
  pageContext?: PageContext
): Promise<ChatMessage> {
  const config = await getConfig();

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
    // Route through Agent Bus — no API key needed in the browser
    const response = await fetch(`${config.agentBusUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Secret': 'azlab-agent-bus',
      },
      body: JSON.stringify({
        system: systemPrompt,
        messages,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Agent Bus /chat ${response.status}: ${err}`);
    }

    const data = await response.json();
    if (data.error) throw new Error(data.error);

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: data.content,
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
