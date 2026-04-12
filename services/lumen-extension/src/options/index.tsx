import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import { getConfig, saveConfig, DEFAULT_CONFIG, type LumenConfig } from '../shared/config';

const fieldStyle: Record<string, string> = {
  width: '100%',
  background: '#27272a',
  color: '#fafafa',
  border: '1px solid #3f3f46',
  borderRadius: '6px',
  padding: '8px 10px',
  fontSize: '13px',
  fontFamily: 'monospace',
};

const labelStyle: Record<string, string> = {
  display: 'block',
  marginBottom: '4px',
  fontSize: '12px',
  color: '#a1a1aa',
  fontWeight: '500',
};

function Options() {
  const [config, setConfig] = useState<LumenConfig>({ ...DEFAULT_CONFIG });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig);
  }, []);

  const handleSave = async () => {
    await saveConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const field = (key: keyof LumenConfig, label: string, placeholder?: string, isSecret = false) => (
    <div style={{ marginBottom: '16px' }}>
      <label style={labelStyle}>{label}</label>
      <input
        type={isSecret ? 'password' : 'text'}
        style={fieldStyle}
        value={(config[key] as string) ?? ''}
        placeholder={placeholder ?? (DEFAULT_CONFIG as any)[key] ?? ''}
        onInput={(e) => setConfig({ ...config, [key]: (e.target as HTMLInputElement).value })}
      />
    </div>
  );

  return (
    <div>
      <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#a78bfa', marginBottom: '4px' }}>
        Lumen Settings
      </h1>
      <p style={{ color: '#71717a', marginBottom: '24px', fontSize: '13px' }}>
        Configure endpoints for the az-lab agentic system. LLM calls route through Agent Bus — no API key needed.
      </p>

      <h2 style={{ fontSize: '14px', color: '#a1a1aa', marginBottom: '12px', borderBottom: '1px solid #3f3f46', paddingBottom: '4px' }}>
        Endpoints
      </h2>
      {field('memoryMcpUrl', 'Memory MCP Server')}
      {field('memoryHealthUrl', 'Memory MCP Health')}
      {field('supabaseUrl', 'Supabase URL')}
      {field('supabaseAnonKey', 'Supabase Anon Key', undefined, true)}
      {field('agentBusUrl', 'Agent Bus URL')}

      <button
        onClick={handleSave}
        style={{
          background: saved ? '#22c55e' : '#7c3aed',
          color: 'white',
          border: 'none',
          borderRadius: '6px',
          padding: '10px 24px',
          cursor: 'pointer',
          fontSize: '14px',
          fontFamily: 'inherit',
          marginTop: '8px',
          transition: 'background 0.2s',
        }}
      >
        {saved ? 'Saved!' : 'Save Settings'}
      </button>
    </div>
  );
}

render(<Options />, document.getElementById('app')!);
