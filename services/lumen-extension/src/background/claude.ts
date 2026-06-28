// Claude integration — routes through Agent Bus (no API key in browser).
// When `allowActions` is set, exposes the browser-action tools and runs a
// permissioned tool-use loop: each tool_use block is approved by the user
// (or auto-allowed by session scope), dispatched, and the result fed back
// to Claude until it stops requesting tools.

import { getConfig, AGENT_DISPLAY_NAME, STORAGE_KEYS } from '../shared/config';
import type { ChatMessage, PageContext } from '../shared/types';
import { BROWSER_TOOLS, type BrowserActionName } from '../shared/browser-actions';
import { runToolUse } from './actions';

const MAX_TOOL_TURNS = 10;

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

IMPORTANT — your actual capabilities in this chat (state these accurately, never oversell):
- **Seeing the page:** When the user has "Include page context" enabled (it's on by default),
  you receive the current tab's URL, title, any selected text, AND the page's visible text
  (truncated) as a [Page content …] block. So you CAN read and discuss what's on the page the
  user is viewing. If no [Page content] block is present, context is off — ask them to toggle it
  on rather than guessing.
- **Page interaction (NEW):** When the user has "Allow actions" enabled, you get five tools to
  interact with the active tab: browser_click, browser_type, browser_scroll, browser_navigate,
  browser_read_dom. EVERY non-read action triggers a permission prompt the user must approve —
  do not assume the user has granted ongoing permission, and do not retry a denied action. Use
  browser_read_dom (read-only, auto-allowed) to verify a selector before you click or type. Use
  selectors that are stable: prefer id, then data-* attributes, then role-based, then text-anchored.
  If the tool returns "error: no element matches selector", widen your selector or read the DOM first.
- **What you CANNOT do:** you cannot see rendered visuals/layout, screenshots, images, or the
  browser console. The action tools above appear only when the "Allow actions" toggle is on.
- You do NOT have live query tools in this chat panel. You cannot run DB queries, search memory,
  or fetch the task list yourself from within a reply. The Lumen extension UI handles live data
  in its own tabs:
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
// MV3 service workers recycle (~30s idle); this flag tracks whether the current
// SW lifetime has already hydrated `chatHistory` from chrome.storage.local. We
// use it to lazily re-load on first access after a wake, so post-recycle reads
// and chat sends don't start from an empty in-memory array.
let historyLoaded = false;

export async function loadChatHistory(): Promise<ChatMessage[]> {
  const stored = await chrome.storage.local.get('lumen_chat_history');
  chatHistory = stored.lumen_chat_history ?? [];
  historyLoaded = true;
  return chatHistory;
}

export async function ensureChatHistoryLoaded(): Promise<ChatMessage[]> {
  if (historyLoaded) return chatHistory;
  return loadChatHistory();
}

async function saveChatHistory(): Promise<void> {
  if (chatHistory.length > 50) {
    chatHistory = chatHistory.slice(-50);
  }
  // Strip heavy `pageContext.text` before persisting — at 50 entries × ~12k
  // visible-text dumps, the storage blob explodes and slows every read. Keep
  // url/title/selection/tabId so the conversation still renders with context.
  const persisted = chatHistory.map((msg) => {
    if (!msg.pageContext?.text) return msg;
    const { text: _drop, ...rest } = msg.pageContext;
    return { ...msg, pageContext: rest };
  });
  await chrome.storage.local.set({ lumen_chat_history: persisted });
}

// Anthropic content block shapes (subset we care about).
type TextBlock = { type: 'text'; text: string };
type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface ApiMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

async function callAgentBusChat(
  agentBusUrl: string,
  systemPrompt: string,
  messages: ApiMessage[],
  tools?: typeof BROWSER_TOOLS,
): Promise<{ content: string; blocks?: ContentBlock[]; stop_reason?: string }> {
  const response = await fetch(`${agentBusUrl}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Secret': import.meta.env.VITE_AGENT_BUS_SECRET as string,
    },
    body: JSON.stringify({
      system: systemPrompt,
      messages,
      max_tokens: 4096,
      ...(tools ? { tools } : {}),
    }),
  });
  if (!response.ok) throw new Error(`Agent Bus /chat ${response.status}: ${await response.text()}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
}

export async function chat(
  userMessage: string,
  pageContext?: PageContext,
  allowActions: boolean = false,
): Promise<ChatMessage> {
  const config = await getConfig();

  // Re-hydrate from storage if this SW lifetime hasn't loaded yet — otherwise a
  // post-recycle send would start from an empty in-memory array and drop prior turns.
  await ensureChatHistoryLoaded();

  const userMsg: ChatMessage = {
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
    pageContext,
  };
  chatHistory.push(userMsg);

  const stored = await chrome.storage.local.get(STORAGE_KEYS.feedbackMemories);
  const feedbackRules = (stored[STORAGE_KEYS.feedbackMemories] ?? []).join('\n\n');
  const systemPrompt = SYSTEM_PROMPT.replace('{FEEDBACK_RULES}', feedbackRules || '(none loaded yet — run startup)');

  // Build messages for API from the persisted history. Page context rides on
  // every turn that had it; the heavy `text` block attaches only to the most
  // recent user turn so history doesn't keep ballooning with stale page dumps.
  const lastIdx = chatHistory.length - 1;
  const messages: ApiMessage[] = chatHistory.map((msg, i) => {
    if (msg.role === 'user' && msg.pageContext) {
      const pc = msg.pageContext;
      let suffix = `\n\n[Page: ${pc.title} — ${pc.url}]`;
      if (pc.selection) suffix += `\n[Selection: ${pc.selection}]`;
      if (i === lastIdx && pc.text) suffix += `\n[Page content (visible text):\n${pc.text}\n]`;
      return { role: 'user' as const, content: `${msg.content}${suffix}` };
    }
    return { role: msg.role as 'user' | 'assistant', content: msg.content };
  });

  try {
    const tools = allowActions ? BROWSER_TOOLS : undefined;
    let data = await callAgentBusChat(config.agentBusUrl, systemPrompt, messages, tools);

    // Tool-use loop — runs only when tools were exposed. Each iteration:
    // 1) append assistant's content blocks (text + tool_use) to messages
    // 2) execute each tool_use through the permission gate
    // 3) append a user turn containing tool_result blocks
    // 4) call /chat again. Bail out at MAX_TOOL_TURNS to prevent runaway loops.
    let turns = 0;
    while (allowActions && data.stop_reason === 'tool_use' && data.blocks && turns < MAX_TOOL_TURNS) {
      turns++;
      const assistantBlocks = data.blocks;
      messages.push({ role: 'assistant', content: assistantBlocks });

      const toolUses = assistantBlocks.filter((b): b is ToolUseBlock => b.type === 'tool_use');
      const toolResults: ToolResultBlock[] = [];
      for (const tu of toolUses) {
        const res = await runToolUse({
          id: tu.id,
          name: tu.name as BrowserActionName,
          input: tu.input,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: res.tool_use_id,
          content: res.content,
          ...(res.is_error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: toolResults });
      data = await callAgentBusChat(config.agentBusUrl, systemPrompt, messages, tools);
    }

    if (allowActions && turns >= MAX_TOOL_TURNS && data.stop_reason === 'tool_use') {
      data = { ...data, content: data.content + `\n\n[stopped after ${MAX_TOOL_TURNS} tool turns — ask user to continue]` };
    }

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: data.content || '(no text content)',
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
  historyLoaded = true;
  await chrome.storage.local.remove('lumen_chat_history');
}
