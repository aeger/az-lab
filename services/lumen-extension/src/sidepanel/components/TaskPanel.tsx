import { useState, useEffect } from 'preact/hooks';
import type { Task } from '../../shared/types';

export function TaskPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('pending');
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadTasks = async () => {
    setLoading(true);
    try {
      const res: any = await chrome.runtime.sendMessage({
        type: 'TASK_LIST',
        payload: { status: filter || undefined },
      });
      if (res?.type === 'TASK_RESULTS') {
        setTasks(res.payload);
      }
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadTasks(); }, [filter]);

  const priorityClass = (p: number) =>
    p === 1 ? 'priority-1' : p === 2 ? 'priority-2' : 'priority-3';

  const statusColor = (s: string) => {
    const colors: Record<string, string> = {
      pending: 'var(--warning)',
      in_progress: 'var(--accent)',
      completed: 'var(--success)',
      failed: 'var(--error)',
      cancelled: 'var(--text-muted)',
    };
    return colors[s] ?? 'var(--text-muted)';
  };

  return (
    <>
      <div class="search-bar">
        <select
          value={filter}
          onChange={(e) => setFilter((e.target as HTMLSelectElement).value)}
          style={{
            flex: 1,
            background: 'var(--bg-tertiary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '6px 8px',
            fontSize: '13px',
          }}
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        <button onClick={loadTasks} disabled={loading}>
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tasks.length === 0 && !loading && (
          <div class="empty">No {filter || ''} tasks</div>
        )}
        {tasks.map((task) => (
          <div
            key={task.id}
            class="list-item"
            onClick={() => setExpanded(expanded === task.id ? null : task.id)}
          >
            <div class="name">
              <span style={{ color: statusColor(task.status), marginRight: '6px', fontSize: '10px' }}>
                {task.status.toUpperCase()}
              </span>
              {task.title}
            </div>
            <div class="meta">
              <span class={`tag ${priorityClass(task.priority)}`}>P{task.priority}</span>
              <span class="tag">{task.source} → {task.target}</span>
              {task.tags?.slice(0, 2).map((t) => (
                <span key={t} class="tag">{t}</span>
              ))}
            </div>
            {expanded === task.id && (
              <div style={{
                marginTop: '8px',
                padding: '8px',
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius)',
                fontSize: '11px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--text-secondary)',
              }}>
                {task.description}
                {task.result && (
                  <>
                    <div style={{ marginTop: '8px', color: 'var(--success)', fontWeight: 'bold' }}>Result:</div>
                    {task.result}
                  </>
                )}
                {task.error && (
                  <>
                    <div style={{ marginTop: '8px', color: 'var(--error)', fontWeight: 'bold' }}>Error:</div>
                    {task.error}
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
