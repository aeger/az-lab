import { useState, useEffect } from 'preact/hooks';
import type { Task } from '../../shared/types';

const TARGETS = ['wren', 'iris', 'atlas', 'lumen', 'any'] as const;

export function TaskPanel() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('active');
  const [expanded, setExpanded] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState<string>('wren');
  const [priority, setPriority] = useState<number>(2);
  const [tagsInput, setTagsInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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

  const resetForm = () => {
    setTitle('');
    setDescription('');
    setTarget('wren');
    setPriority(2);
    setTagsInput('');
    setFormError(null);
  };

  const submitTask = async (e: Event) => {
    e.preventDefault();
    if (!title.trim()) {
      setFormError('Title is required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const tags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      const res: any = await chrome.runtime.sendMessage({
        type: 'TASK_CREATE',
        payload: {
          title: title.trim(),
          description: description.trim(),
          target,
          priority,
          tags,
        },
      });
      if (res?.type === 'TASK_CREATED' && res.payload?.success) {
        resetForm();
        setShowForm(false);
        await loadTasks();
      } else {
        setFormError(res?.payload?.error || 'Task creation failed (no envelope)');
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const priorityClass = (p: number) =>
    p === 1 ? 'priority-1' : p === 2 ? 'priority-2' : 'priority-3';

  const statusColor = (s: string) => {
    const colors: Record<string, string> = {
      ready: 'var(--warning)',
      pending: 'var(--warning)',
      in_progress: 'var(--accent)',
      review_needed: 'var(--accent)',
      blocked: 'var(--error)',
      paused: 'var(--text-muted)',
      escalated: 'var(--error)',
      completed: 'var(--success)',
      failed: 'var(--error)',
      cancelled: 'var(--text-muted)',
      archived: 'var(--text-muted)',
    };
    return colors[s] ?? 'var(--text-muted)';
  };

  const fieldStyle = {
    width: '100%',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '6px 8px',
    fontSize: '13px',
    fontFamily: 'inherit',
  } as const;

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
          <option value="active">Active</option>
          <option value="ready">Ready</option>
          <option value="in_progress">In Progress</option>
          <option value="review_needed">Review Needed</option>
          <option value="blocked">Blocked</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
          <option value="">All</option>
        </select>
        <button
          onClick={() => {
            setShowForm((v) => !v);
            setFormError(null);
          }}
        >
          {showForm ? 'Cancel' : 'New Task'}
        </button>
        <button onClick={loadTasks} disabled={loading}>
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={submitTask}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            padding: '8px 12px',
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <input
            type="text"
            placeholder="Title"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            disabled={submitting}
            style={fieldStyle}
            required
          />
          <textarea
            placeholder="Description"
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            disabled={submitting}
            rows={3}
            style={{ ...fieldStyle, resize: 'vertical', minHeight: '52px' }}
          />
          <div style={{ display: 'flex', gap: '6px' }}>
            <select
              value={target}
              onChange={(e) => setTarget((e.target as HTMLSelectElement).value)}
              disabled={submitting}
              style={{ ...fieldStyle, flex: 1 }}
            >
              {TARGETS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <select
              value={String(priority)}
              onChange={(e) => setPriority(Number((e.target as HTMLSelectElement).value))}
              disabled={submitting}
              style={{ ...fieldStyle, flex: 1 }}
            >
              <option value="1">P1 — Critical</option>
              <option value="2">P2 — Normal</option>
              <option value="3">P3 — Low</option>
            </select>
          </div>
          <input
            type="text"
            placeholder="Tags (comma-separated, optional)"
            value={tagsInput}
            onInput={(e) => setTagsInput((e.target as HTMLInputElement).value)}
            disabled={submitting}
            style={fieldStyle}
          />
          {formError && (
            <div style={{
              padding: '6px 8px',
              background: 'rgba(239, 68, 68, 0.15)',
              color: 'var(--error)',
              borderRadius: 'var(--radius)',
              fontSize: '11px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {formError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => { resetForm(); setShowForm(false); }}
              disabled={submitting}
              style={{
                background: 'var(--bg-tertiary)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                padding: '6px 12px',
                cursor: submitting ? 'not-allowed' : 'pointer',
                fontSize: '12px',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                background: 'var(--accent-dim)',
                color: 'white',
                border: 'none',
                borderRadius: 'var(--radius)',
                padding: '6px 12px',
                cursor: submitting ? 'not-allowed' : 'pointer',
                fontSize: '12px',
              }}
            >
              {submitting ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      )}

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
