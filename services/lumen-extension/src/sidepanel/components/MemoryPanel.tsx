import { useState } from 'preact/hooks';
import type { Memory } from '../../shared/types';

export function MemoryPanel() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const res: any = await chrome.runtime.sendMessage({
        type: 'MEMORY_SEARCH',
        payload: { query: query.trim() },
      });
      if (res?.type === 'MEMORY_RESULTS') {
        setResults(res.payload);
      }
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') search();
  };

  return (
    <>
      <div class="search-bar">
        <input
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
          placeholder="Search memories..."
        />
        <button onClick={search} disabled={loading}>
          {loading ? '...' : 'Search'}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {results.length === 0 && !loading && (
          <div class="empty">Search your shared memory database</div>
        )}
        {results.map((mem) => (
          <div
            key={mem.id}
            class="list-item"
            onClick={() => setExpanded(expanded === mem.id ? null : mem.id)}
          >
            <div class="name">{mem.name}</div>
            <div class="desc">{mem.description}</div>
            <div class="meta">
              <span class="tag type">{mem.type}</span>
              {mem.tags?.slice(0, 3).map((t) => (
                <span key={t} class="tag">{t}</span>
              ))}
            </div>
            {expanded === mem.id && (
              <pre style={{
                marginTop: '8px',
                padding: '8px',
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius)',
                fontSize: '11px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '300px',
                overflowY: 'auto',
                color: 'var(--text-secondary)',
              }}>
                {mem.content}
              </pre>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
