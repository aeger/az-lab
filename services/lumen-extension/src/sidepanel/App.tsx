import { useState, useEffect } from 'preact/hooks';
import type { AgentStatus } from '../shared/types';
import { Chat } from './components/Chat';
import { MemoryPanel } from './components/MemoryPanel';
import { TaskPanel } from './components/TaskPanel';
import { AlertsPanel } from './components/AlertsPanel';

type Tab = 'chat' | 'memory' | 'tasks' | 'alerts';

export function App() {
  const [tab, setTab] = useState<Tab>('alerts');
  const [alertBadge, setAlertBadge] = useState(0);
  const [status, setStatus] = useState<AgentStatus>({
    memoryMcp: 'disconnected',
    supabase: 'disconnected',
    agentBus: 'disconnected',
    anthropic: 'missing_key',
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

    // Poll for unread count for tab badge
    const notifInterval = setInterval(async () => {
      const res: any = await chrome.runtime.sendMessage({ type: 'NOTIF_LIST', payload: { status: 'unread', limit: 1 } }).catch(() => null);
      if (res?.type === 'NOTIF_RESULTS') setAlertBadge(res.payload.unreadCount);
    }, 30000);
    // Initial load
    chrome.runtime.sendMessage({ type: 'NOTIF_LIST', payload: { status: 'unread', limit: 1 } }).then((res: any) => {
      if (res?.type === 'NOTIF_RESULTS') setAlertBadge(res.payload.unreadCount);
    }).catch(() => {});

    return () => { clearInterval(interval); clearInterval(notifInterval); };
  }, []);

  return (
    <>
      <div class="header">
        <h1>Lumen</h1>
        <div class="status-dots">
          <div class={`status-dot ${status.supabase}`} title={`Supabase: ${status.supabase}`} />
          <div class={`status-dot ${status.memoryMcp}`} title={`Memory MCP: ${status.memoryMcp}`} />
          <div class={`status-dot ${status.agentBus}`} title={`Agent Bus: ${status.agentBus}`} />
          <div class={`status-dot ${status.anthropic}`} title={`Claude API: ${status.anthropic}`} />
        </div>
      </div>

      <div class="tabs">
        <button class={`tab ${tab === 'alerts' ? 'active' : ''}`} onClick={() => setTab('alerts')} style={{ position: 'relative' }}>
          Alerts
          {alertBadge > 0 && (
            <span style={{
              position: 'absolute', top: '-3px', right: '-3px',
              minWidth: '14px', height: '14px', borderRadius: '7px',
              background: '#ef4444', color: '#fff', fontSize: '8px',
              fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 2px',
            }}>
              {alertBadge > 99 ? '99+' : alertBadge}
            </span>
          )}
        </button>
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
        {tab === 'alerts' && <AlertsPanel />}
        {tab === 'chat' && <Chat />}
        {tab === 'memory' && <MemoryPanel />}
        {tab === 'tasks' && <TaskPanel />}
      </div>
    </>
  );
}
