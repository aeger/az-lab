// Executor for Lumen's data-layer tools (task queue + shared memory).
// Mirrors the { tool_use_id, content, is_error? } result shape of runToolUse so
// the chat loop in claude.ts can handle browser and data tools uniformly.

import { createTask, fetchTasks, searchMemoriesKeyword, upsertMemory } from './supabase';
import type { DataToolName } from '../shared/data-tools';

export interface DataToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export async function runDataTool(tu: {
  id: string;
  name: DataToolName;
  input: Record<string, unknown>;
}): Promise<DataToolResult> {
  try {
    switch (tu.name) {
      case 'create_task': {
        const title = String(tu.input.title ?? '').trim();
        const description = String(tu.input.description ?? '').trim();
        if (!title || !description) throw new Error('title and description are required');
        const target = String(tu.input.target ?? 'wren');
        const priority = typeof tu.input.priority === 'number' ? tu.input.priority : undefined;
        const rows = await createTask({ title, description, target, priority });
        const id = rows[0]?.id ?? '(unknown)';
        return {
          tool_use_id: tu.id,
          content: `Created task ${id} for ${target} (priority ${priority ?? 2}): "${title}"`,
        };
      }
      case 'list_tasks': {
        const status = tu.input.status ? String(tu.input.status) : undefined;
        const limit = typeof tu.input.limit === 'number' ? tu.input.limit : 15;
        const rows = await fetchTasks(status, limit);
        if (!rows.length) return { tool_use_id: tu.id, content: 'No matching tasks.' };
        const lines = rows
          .map((t) => `- [${t.status}] ${t.title} (target=${t.target}, id=${t.id})`)
          .join('\n');
        return { tool_use_id: tu.id, content: `${rows.length} task(s):\n${lines}` };
      }
      case 'search_memory': {
        const query = String(tu.input.query ?? '').trim();
        if (!query) throw new Error('query is required');
        const limit = typeof tu.input.limit === 'number' ? tu.input.limit : 8;
        const rows = await searchMemoriesKeyword(query, limit);
        if (!rows.length) return { tool_use_id: tu.id, content: `No memories matched "${query}".` };
        const lines = rows
          .map((m) => `- ${m.name} [${m.type}]: ${m.description || (m.content ?? '').slice(0, 100)}`)
          .join('\n');
        return { tool_use_id: tu.id, content: `${rows.length} memory match(es):\n${lines}` };
      }
      case 'save_memory': {
        const name = String(tu.input.name ?? '').trim();
        const content = String(tu.input.content ?? '').trim();
        if (!name || !content) throw new Error('name and content are required');
        const type = String(tu.input.type ?? 'project');
        const description = String(tu.input.description ?? content.slice(0, 80));
        const tags = Array.isArray(tu.input.tags) ? tu.input.tags.map(String) : undefined;
        await upsertMemory({ name, type, description, content, tags });
        return { tool_use_id: tu.id, content: `Saved memory "${name}" [${type}].` };
      }
      default:
        return { tool_use_id: tu.id, content: `Unknown data tool: ${tu.name}`, is_error: true };
    }
  } catch (e) {
    return {
      tool_use_id: tu.id,
      content: `Error: ${e instanceof Error ? e.message : String(e)}`,
      is_error: true,
    };
  }
}
