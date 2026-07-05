// Data-layer tool definitions for Lumen chat: task queue + shared memory.
// Unlike BROWSER_TOOLS (DOM actions, gated behind "Allow actions"), these run
// against the live az-lab Supabase via Hermes and are ALWAYS available in chat —
// they're low-risk reads/writes to the lab's own data, no per-call permission gate.
// Execution lives in background/data-actions.ts.

export const DATA_TOOLS = [
  {
    name: 'create_task',
    description:
      'Create a task in the shared az-lab task_queue for an agent to execute. Use when the user ' +
      'asks you to hand work to Wren (server/infra/code/deploy) or another agent. Returns the new task id.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: {
          type: 'string',
          description: 'Full detail — what to do, acceptance criteria, relevant context',
        },
        target: {
          type: 'string',
          enum: ['wren', 'iris', 'atlas', 'volt'],
          description: 'Agent to assign. Default wren for any server/infra/code/deploy work.',
        },
        priority: {
          type: 'integer',
          description: 'Priority: 0=critical, 1=high, 2=normal (default), 3=low',
        },
      },
      required: ['title', 'description'],
    },
  },
  {
    name: 'list_tasks',
    description:
      "Read tasks from the shared task_queue. Use to answer \"what's in the queue\" or to check a " +
      "task's status. There are typically hundreds of completed rows — filter to 'active' for what's in flight.",
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: "Optional filter: 'active' (non-terminal) or an exact status like in_progress/completed/blocked",
        },
        limit: { type: 'integer', description: 'Max rows (default 15)' },
      },
      required: [],
    },
  },
  {
    name: 'search_memory',
    description:
      'Keyword-search the shared Supabase memories (matches name/description/content). Use to recall ' +
      'facts, prior decisions, references, or feedback before answering.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s) to search for' },
        limit: { type: 'integer', description: 'Max results (default 8)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'save_memory',
    description:
      'Save or update a shared memory. Use when the user asks you to remember something durable ' +
      '(a fact, preference, decision, or reference). Overwrites any existing memory with the same name.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case slug identifying the memory' },
        content: { type: 'string', description: 'The fact / note to store' },
        type: {
          type: 'string',
          enum: ['project', 'reference', 'feedback', 'user', 'semantic', 'episodic'],
          description: 'Memory type (default project)',
        },
        description: { type: 'string', description: 'One-line summary used for recall' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['name', 'content'],
    },
  },
] as const;

export type DataToolName = (typeof DATA_TOOLS)[number]['name'];

const DATA_TOOL_NAMES: readonly string[] = DATA_TOOLS.map((t) => t.name);

export function isDataTool(name: string): name is DataToolName {
  return DATA_TOOL_NAMES.includes(name);
}
