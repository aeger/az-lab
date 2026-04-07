// Message passing between background, content, popup, and sidepanel

import type { ChatMessage, PageContext, AgentStatus, Memory, Task } from './types';

// Background ← Content
export type ContentMessage =
  | { type: 'PAGE_CONTEXT'; payload: PageContext }
  | { type: 'SELECTION_CHANGED'; payload: { text: string; url: string } };

// Background ← Popup/Sidepanel
export type UIMessage =
  | { type: 'CHAT_SEND'; payload: { message: string; includePageContext: boolean } }
  | { type: 'MEMORY_SEARCH'; payload: { query: string; type?: string } }
  | { type: 'MEMORY_STORE'; payload: { name: string; type: string; description: string; content: string; tags: string[] } }
  | { type: 'TASK_LIST'; payload?: { status?: string } }
  | { type: 'TASK_CREATE'; payload: { title: string; description: string; target: string; priority: number; tags: string[] } }
  | { type: 'GET_STATUS' }
  | { type: 'GET_CHAT_HISTORY' }
  | { type: 'OPEN_SIDEPANEL' }
  | { type: 'RUN_STARTUP' };

// Background → UI (responses)
export type BackgroundResponse =
  | { type: 'CHAT_RESPONSE'; payload: ChatMessage }
  | { type: 'MEMORY_RESULTS'; payload: Memory[] }
  | { type: 'MEMORY_STORED'; payload: { success: boolean; error?: string } }
  | { type: 'TASK_RESULTS'; payload: Task[] }
  | { type: 'TASK_CREATED'; payload: { success: boolean; id?: string; error?: string } }
  | { type: 'STATUS'; payload: AgentStatus }
  | { type: 'CHAT_HISTORY'; payload: ChatMessage[] }
  | { type: 'ERROR'; payload: { message: string } };

export type LumenMessage = ContentMessage | UIMessage;
