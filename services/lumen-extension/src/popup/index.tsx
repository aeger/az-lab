import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import type { AgentStatus } from '../shared/types';

function Popup() {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((res: any) => {
      if (res?.type === 'STATUS') setStatus(res.payload);
    }).catch(() => {});
  }, []);

  const openSidePanel = () => {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
    window.close();
  };

  const openOptions = () => {
    chrome.runtime.openOptionsPage();
    window.close();
  };

  const runStartup = async () => {
    const res: any = await chrome.runtime.sendMessage({ type: 'RUN_STARTUP' });
    if (res?.type === 'STATUS') setStatus(res.payload);
  };

  const dot = (s: string) => {
    const colors: Record<string, string> = {
      connected: '#22c55e', configured: '#22c55e',
      disconnected: '#ef4444', error: '#f59e0b',
      missing_key: '#71717a',
    };
    return colors[s] ?? '#71717a';
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <span style={{ fontSize: '18px', fontWeight: 700, color: '#a78bfa' }}>Lumen</span>
        <span style={{ fontSize: '11px', color: '#71717a' }}>v0.1.0</span>
      </div>

      {status && (
        <div style={{ marginBottom: '12px', fontSize: '12px' }}>
          {([
            ['Supabase', status.supabase],
            ['Memory MCP', status.memoryMcp],
            ['Agent Bus', status.agentBus],
            ['Chat', status.chatBackend],
          ] as [string, string][]).map(([label, s]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: dot(s), display: 'inline-block' }} />
              <span style={{ color: '#a1a1aa' }}>{label}:</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <button onClick={openSidePanel} style={btnStyle}>Open Side Panel</button>
        <button onClick={runStartup} style={btnStyle}>Re-run Startup</button>
        <button onClick={openOptions} style={{ ...btnStyle, background: '#3f3f46' }}>Settings</button>
      </div>
    </div>
  );
}

const btnStyle: Record<string, string> = {
  background: '#7c3aed',
  color: 'white',
  border: 'none',
  borderRadius: '6px',
  padding: '8px 12px',
  cursor: 'pointer',
  fontSize: '13px',
  fontFamily: 'inherit',
};

render(<Popup />, document.getElementById('app')!);
