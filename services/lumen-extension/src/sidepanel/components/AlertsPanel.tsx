import { useState, useEffect, useCallback } from 'preact/hooks';
import type { SentinelNotification, Urgency, SoundPrefs } from '../../shared/types';
import { DEFAULT_SOUND_PREFS } from '../../shared/types';
import { playSound, playSoundForUrgency, ALL_SOUND_IDS, SOUND_LABELS } from '../../shared/sounds';

type Filter = 'all' | 'unread' | 'critical' | 'high';

const URGENCY_COLOR: Record<Urgency, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#6b7280',
};

const URGENCY_BG: Record<Urgency, string> = {
  critical: 'rgba(239,68,68,0.12)',
  high: 'rgba(249,115,22,0.12)',
  medium: 'rgba(234,179,8,0.1)',
  low: 'rgba(107,114,128,0.08)',
};

const SOURCE_EMOJI: Record<string, string> = {
  task_queue: '📋', services: '🔧', home_assistant: '🏡', discord: '💬', grafana: '📊',
};

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function AlertsPanel() {
  const [notifications, setNotifications] = useState<SentinelNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [filter, setFilter] = useState<Filter>('unread');
  const [loading, setLoading] = useState(true);
  const [showSoundSettings, setShowSoundSettings] = useState(false);
  const [soundPrefs, setSoundPrefs] = useState<SoundPrefs>(DEFAULT_SOUND_PREFS);
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadSoundPrefs = useCallback(async () => {
    const res = await chrome.runtime.sendMessage({ type: 'GET_SOUND_PREFS' });
    if (res?.type === 'SOUND_PREFS' && Object.keys(res.payload).length > 0) {
      setSoundPrefs({ ...DEFAULT_SOUND_PREFS, ...res.payload });
    }
  }, []);

  const fetchNotifications = useCallback(async (playNewSounds = false) => {
    const res = await chrome.runtime.sendMessage({
      type: 'NOTIF_LIST',
      payload: { limit: 50 },
    });
    if (res?.type === 'NOTIF_RESULTS') {
      const prev = notifications;
      const newNotifs = (res.payload.notifications as SentinelNotification[]).filter(n =>
        n.status === 'unread' && !prev.some(p => p.id === n.id)
      );

      if (playNewSounds && newNotifs.length > 0) {
        // Play sound for the highest urgency new notification
        const urgencies: Urgency[] = ['critical', 'high', 'medium', 'low'];
        for (const u of urgencies) {
          if (newNotifs.some(n => n.urgency === u)) {
            playSoundForUrgency(u, soundPrefs as any);
            break;
          }
        }
      }

      setNotifications(res.payload.notifications);
      setUnreadCount(res.payload.unreadCount);
      setCriticalCount(res.payload.criticalCount);
      setLoading(false);
    }
  }, [notifications, soundPrefs]);

  useEffect(() => {
    loadSoundPrefs();
    fetchNotifications(false);
    const interval = setInterval(() => fetchNotifications(true), 30_000);
    return () => clearInterval(interval);
  }, []);

  async function markRead(id: string) {
    await chrome.runtime.sendMessage({ type: 'NOTIF_READ', payload: { id } });
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, status: 'read' as const } : n));
    setUnreadCount(c => Math.max(0, c - 1));
  }

  async function markAllRead() {
    await chrome.runtime.sendMessage({ type: 'NOTIF_READ_ALL' });
    setNotifications(prev => prev.map(n => ({ ...n, status: 'read' as const })));
    setUnreadCount(0);
    setCriticalCount(0);
  }

  async function saveSoundPrefs(prefs: SoundPrefs) {
    setSoundPrefs(prefs);
    await chrome.runtime.sendMessage({ type: 'SET_SOUND_PREFS', payload: prefs });
  }

  function testSound(urgency: string) {
    const pref = (soundPrefs as any)[urgency];
    if (pref?.soundId) playSound(pref.soundId, pref.volume ?? 0.7);
  }

  const filtered = notifications.filter(n => {
    if (filter === 'unread') return n.status === 'unread';
    if (filter === 'critical') return n.urgency === 'critical';
    if (filter === 'high') return n.urgency === 'critical' || n.urgency === 'high';
    return true;
  });

  if (showSoundSettings) {
    return <SoundSettingsPanel
      prefs={soundPrefs}
      onChange={saveSoundPrefs}
      onTest={testSound}
      onBack={() => setShowSoundSettings(false)}
    />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '10px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span>🔔</span>
            <span style={{ fontSize: '13px', fontWeight: 600, color: '#e4e4e7' }}>Alerts</span>
            {unreadCount > 0 && (
              <span style={{
                padding: '1px 6px', borderRadius: '8px', fontSize: '10px', fontWeight: 700,
                background: criticalCount > 0 ? 'rgba(239,68,68,0.2)' : 'rgba(249,115,22,0.2)',
                color: criticalCount > 0 ? '#ef4444' : '#f97316',
              }}>
                {unreadCount}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            {unreadCount > 0 && (
              <button onClick={markAllRead} style={{
                fontSize: '10px', color: '#52525b', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
              }}>
                ✓ all
              </button>
            )}
            <button onClick={() => setShowSoundSettings(true)} style={{
              fontSize: '12px', color: '#52525b', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
            }} title="Sound settings">
              🔊
            </button>
          </div>
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['unread', 'all', 'critical', 'high'] as Filter[]).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '3px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 500,
                cursor: 'pointer', border: 'none', transition: 'all 0.15s',
                background: filter === f ? 'rgba(139,92,246,0.2)' : 'rgba(255,255,255,0.04)',
                color: filter === f ? '#c084fc' : '#52525b',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#3f3f46', fontSize: '11px' }}>
            Loading...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '24px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: '24px', marginBottom: '6px' }}>✅</div>
            <div style={{ color: '#3f3f46', fontSize: '11px' }}>No {filter === 'all' ? '' : filter} alerts</div>
          </div>
        ) : (
          filtered.map(n => {
            const color = URGENCY_COLOR[n.urgency];
            const isRead = n.status === 'read';
            const emoji = SOURCE_EMOJI[n.source] || '🔔';

            return (
              <div
                key={n.id}
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  borderLeft: `2px solid ${isRead ? color + '30' : color}`,
                  cursor: 'pointer',
                  opacity: isRead ? 0.55 : 1,
                  background: expanded === n.id ? 'rgba(255,255,255,0.04)' : 'transparent',
                }}
                onClick={() => setExpanded(expanded === n.id ? null : n.id)}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                  <span style={{ fontSize: '13px', flexShrink: 0, marginTop: '1px' }}>{emoji}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '6px' }}>
                      <p style={{
                        fontSize: '11px', fontWeight: isRead ? 400 : 600, lineHeight: 1.3, margin: 0,
                        color: isRead ? '#52525b' : '#e4e4e7',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        flex: 1,
                      }}>
                        {n.title}
                      </p>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                        <span style={{
                          padding: '1px 4px', borderRadius: '3px', fontSize: '9px', fontWeight: 700,
                          background: URGENCY_BG[n.urgency], color,
                        }}>
                          {n.urgency.toUpperCase().slice(0, 4)}
                        </span>
                        {!isRead && (
                          <button
                            onClick={e => { e.stopPropagation(); markRead(n.id); }}
                            style={{ fontSize: '10px', color: '#3f3f46', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 }}
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', marginTop: '2px', alignItems: 'center' }}>
                      <span style={{ fontSize: '9px', color: '#3f3f46' }}>
                        {n.category.replace(/_/g, ' ')}
                      </span>
                      <span style={{ color: '#27272a', fontSize: '9px' }}>·</span>
                      <span style={{ fontSize: '9px', color: '#3f3f46' }}>{timeAgo(n.timestamp)}</span>
                    </div>
                  </div>
                </div>

                {expanded === n.id && n.body && (
                  <div style={{
                    marginTop: '6px', marginLeft: '19px', padding: '6px 8px',
                    background: 'rgba(255,255,255,0.03)', borderRadius: '4px',
                    fontSize: '10px', color: '#71717a', lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                  }}>
                    {n.body.slice(0, 400)}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '6px 12px', borderTop: '1px solid rgba(255,255,255,0.05)',
        fontSize: '9px', color: '#27272a', display: 'flex', justifyContent: 'space-between',
      }}>
        <span>JeffSentinel v2</span>
        <button
          onClick={() => fetchNotifications(false)}
          style={{ fontSize: '9px', color: '#27272a', background: 'none', border: 'none', cursor: 'pointer' }}
        >
          ↻ refresh
        </button>
      </div>
    </div>
  );
}

// --- Sound settings sub-panel ---

interface SoundSettingsPanelProps {
  prefs: SoundPrefs;
  onChange: (p: SoundPrefs) => void;
  onTest: (u: string) => void;
  onBack: () => void;
}

const URGENCY_ORDER: Urgency[] = ['critical', 'high', 'medium', 'low'];
const URGENCY_LABELS: Record<Urgency, string> = {
  critical: '🚨 Critical',
  high: '⚠️ High',
  medium: '🔔 Medium',
  low: 'ℹ️ Low',
};

function SoundSettingsPanel({ prefs, onChange, onTest, onBack }: SoundSettingsPanelProps) {
  function updatePref(urgency: Urgency, field: string, value: unknown) {
    onChange({
      ...prefs,
      [urgency]: { ...(prefs[urgency] as any), [field]: value },
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button onClick={onBack} style={{ fontSize: '12px', background: 'none', border: 'none', cursor: 'pointer', color: '#71717a' }}>←</button>
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#e4e4e7' }}>🔊 Sound Settings</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        <p style={{ fontSize: '10px', color: '#52525b', marginBottom: '12px' }}>
          Customize alert sounds per urgency level. Test each sound before saving.
        </p>

        {URGENCY_ORDER.map(urgency => {
          const pref = prefs[urgency] as any;
          const color = URGENCY_COLOR[urgency];

          return (
            <div key={urgency} style={{
              marginBottom: '14px', padding: '10px', borderRadius: '8px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
              borderLeft: `3px solid ${color}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color }}>{URGENCY_LABELS[urgency]}</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={pref.enabled}
                    onChange={e => updatePref(urgency, 'enabled', (e.target as HTMLInputElement).checked)}
                    style={{ accentColor: color }}
                  />
                  <span style={{ fontSize: '10px', color: '#71717a' }}>enabled</span>
                </label>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                <select
                  value={pref.soundId}
                  onChange={e => updatePref(urgency, 'soundId', (e.target as HTMLSelectElement).value)}
                  disabled={!pref.enabled}
                  style={{
                    flex: 1, fontSize: '10px', padding: '3px 6px', borderRadius: '4px',
                    background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)',
                    color: '#a1a1aa', outline: 'none',
                  }}
                >
                  {ALL_SOUND_IDS.map(id => (
                    <option key={id} value={id}>{SOUND_LABELS[id]}</option>
                  ))}
                </select>
                <button
                  onClick={() => onTest(urgency)}
                  disabled={!pref.enabled}
                  style={{
                    fontSize: '10px', padding: '3px 8px', borderRadius: '4px', cursor: 'pointer',
                    background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)',
                    color: '#71717a',
                  }}
                >
                  Test
                </button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '9px', color: '#3f3f46' }}>Vol</span>
                <input
                  type="range" min="0" max="1" step="0.1"
                  value={pref.volume}
                  onChange={e => updatePref(urgency, 'volume', parseFloat((e.target as HTMLInputElement).value))}
                  disabled={!pref.enabled}
                  style={{ flex: 1, accentColor: color, cursor: 'pointer' }}
                />
                <span style={{ fontSize: '9px', color: '#3f3f46', minWidth: '24px' }}>
                  {Math.round(pref.volume * 100)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <button
          onClick={onBack}
          style={{
            width: '100%', padding: '7px', borderRadius: '6px', fontSize: '11px',
            fontWeight: 600, cursor: 'pointer', border: 'none',
            background: 'rgba(139,92,246,0.2)', color: '#c084fc',
          }}
        >
          ← Back to Alerts
        </button>
      </div>
    </div>
  );
}
