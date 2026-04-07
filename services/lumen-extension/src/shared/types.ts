// Shared types for Lumen extension

export interface Memory {
  id: string;
  type: 'user' | 'feedback' | 'project' | 'reference';
  name: string;
  description: string;
  content: string;
  tags: string[];
  source: string;
  created_at: string;
  updated_at: string;
  access_count: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  context: Record<string, unknown>;
  priority: number;
  status: 'pending' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'delegated';
  source: string;
  target: string;
  tags: string[];
  result?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  status: 'active' | 'blocked' | 'completed' | 'archived';
  priority: number;
  notes?: string;
  created_at: string;
}

export interface PageContext {
  url: string;
  title: string;
  selection?: string;
  metaDescription?: string;
  tabId: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  pageContext?: PageContext;
}

export interface AgentStatus {
  memoryMcp: 'connected' | 'disconnected' | 'error';
  supabase: 'connected' | 'disconnected' | 'error';
  agentBus: 'connected' | 'disconnected' | 'error';
  anthropic: 'configured' | 'missing_key' | 'error';
}
