import { useState, useEffect } from 'preact/hooks';
import type { AgentStatus } from '../shared/types';
import { Chat } from './components/Chat';
import { MemoryPanel } from './components/MemoryPanel';
import { TaskPanel } from './components/TaskPanel';

type Tab = 'chat' | 'memory' | 'tasks';

export function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const [status, setStatus] = useState<AgentStatus>({
    memoryMcp: 'disconnected',
    supabase: 'disconnected',
    agentBus: 'disconnected',
    chatBackend: 'disconnected',
  });

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((res: any) => {
      if (res?.type === 'STATUS') setStatus(res.payload);
    }).catch(() => {});

    // Refresh status every 30s
    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((res: any) => {
        if (res?.type === 'STATUS') setStatus(res.payload);
      }).catch(() => {});
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <div class="header">
        <h1>Lumen</h1>
        <div class="status-dots">
          <div class={`status-dot ${status.supabase}`} title={`Supabase: ${status.supabase}`} />
          <div class={`status-dot ${status.memoryMcp}`} title={`Memory MCP: ${status.memoryMcp}`} />
          <div class={`status-dot ${status.agentBus}`} title={`Agent Bus: ${status.agentBus}`} />
          <div class={`status-dot ${status.chatBackend}`} title={`Chat: ${status.chatBackend}`} />
        </div>
      </div>

      <div class="tabs">
        <button class={`tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>
          Chat
        </button>
        <button class={`tab ${tab === 'memory' ? 'active' : ''}`} onClick={() => setTab('memory')}>
          Memory
        </button>
        <button class={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>
          Tasks
        </button>
      </div>

      <div class="tab-content">
        {tab === 'chat' && <Chat />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'tasks' && <TaskPanel />}
      </div>
    </>
  );
}
