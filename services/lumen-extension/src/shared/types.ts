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

export type Urgency = 'critical' | 'high' | 'medium' | 'low';

export interface SentinelNotification {
  id: string;
  source: string;
  category: string;
  urgency: Urgency;
  severity: string;
  status: 'unread' | 'read' | 'dismissed';
  title: string;
  body: string;
  timestamp: string;
  receivedAt: string;
  readAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SoundPrefs {
  critical: { soundId: string; volume: number; enabled: boolean };
  high: { soundId: string; volume: number; enabled: boolean };
  medium: { soundId: string; volume: number; enabled: boolean };
  low: { soundId: string; volume: number; enabled: boolean };
}

export const DEFAULT_SOUND_PREFS: SoundPrefs = {
  critical: { soundId: 'bass_alarm', volume: 0.9, enabled: true },
  high: { soundId: 'sharp_chime', volume: 0.7, enabled: true },
  medium: { soundId: 'soft_tone', volume: 0.5, enabled: true },
  low: { soundId: 'gentle_pop', volume: 0.3, enabled: false },
};

export interface AgentStatus {
  memoryMcp: 'connected' | 'disconnected' | 'error';
  supabase: 'connected' | 'disconnected' | 'error';
  agentBus: 'connected' | 'disconnected' | 'error';
  anthropic: 'configured' | 'missing_key' | 'error';
}
