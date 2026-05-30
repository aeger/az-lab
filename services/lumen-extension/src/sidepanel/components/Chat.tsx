import { useState, useEffect, useRef } from 'preact/hooks';
import type { ChatMessage } from '../../shared/types';
import type { PendingAction, PermissionDecision } from '../../shared/browser-actions';
import { describeAction } from '../../shared/browser-actions';

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const [allowActions, setAllowActions] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_HISTORY' }).then((res: any) => {
      if (res?.type === 'CHAT_HISTORY') setMessages(res.payload);
    }).catch(() => {});
  }, []);

  // Listen for PERMISSION_REQUEST broadcasts from the background's tool-use loop.
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg?.type === 'PERMISSION_REQUEST') setPending(msg.payload);
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setLoading(true);

    const now = Date.now();
    chrome.runtime.sendMessage({ type: 'MESSAGE_SENT' }).catch(() => {});
    try { localStorage.setItem('lumen:discord:lastMessageTime', String(now)); } catch { /* may be unavailable */ }

    const userMsg: ChatMessage = { role: 'user', content: text, timestamp: now };
    setMessages(prev => [...prev, userMsg]);

    try {
      const res: any = await chrome.runtime.sendMessage({
        type: 'CHAT_SEND',
        payload: { message: text, includePageContext: includeContext, allowActions },
      });

      if (res?.type === 'CHAT_RESPONSE') {
        setMessages(prev => [...prev, res.payload]);
      }
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant' as const,
        content: `Error: ${err}`,
        timestamp: Date.now(),
      }]);
    } finally {
      setLoading(false);
    }
  };

  const decide = (decision: PermissionDecision['decision']) => {
    if (!pending) return;
    chrome.runtime.sendMessage({
      type: 'PERMISSION_RESPONSE',
      payload: { actionId: pending.id, decision },
    }).catch(() => {});
    setPending(null);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const handleInputChange = (value: string) => {
    setInput(value);
    const isTyping = value.length > 0;
    chrome.runtime.sendMessage({ type: 'TYPING_STATE', payload: { isTyping } }).catch(() => {});
  };

  return (
    <>
      <div class="chat-messages">
        {messages.length === 0 && (
          <div class="empty">
            Hi, I'm Lumen. I can see what you're browsing, search your memories, manage tasks, and coordinate with the team. What do you need?
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} class={`message ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {loading && <div class="loading">Thinking</div>}
        <div ref={messagesEnd} />
      </div>

      {pending && (
        <div class="permission-gate">
          <div class="permission-title">
            Lumen wants to <strong>{describeAction(pending.name, pending.input)}</strong>
          </div>
          <div class="permission-meta">on {pending.origin}</div>
          {typeof pending.input.reason === 'string' && (
            <div class="permission-reason">"{pending.input.reason as string}"</div>
          )}
          <div class="permission-buttons">
            <button class="btn-allow" onClick={() => decide('allow')}>Allow once</button>
            <button class="btn-allow-scope" onClick={() => decide('allow_page')}>Allow on {pending.origin}</button>
            <button class="btn-allow-scope" onClick={() => decide('allow_session')}>Allow this session</button>
            <button class="btn-deny" onClick={() => decide('deny')}>Deny</button>
          </div>
        </div>
      )}

      <div class="context-toggle">
        <input
          type="checkbox"
          id="ctx"
          checked={includeContext}
          onChange={(e) => setIncludeContext((e.target as HTMLInputElement).checked)}
        />
        <label for="ctx">Include page context</label>
        <span style={{ flex: 1 }} />
        <input
          type="checkbox"
          id="act"
          checked={allowActions}
          onChange={(e) => setAllowActions((e.target as HTMLInputElement).checked)}
        />
        <label for="act" title="Lets Lumen request to click/type/scroll/navigate. Each action still needs your approval.">
          Allow actions
        </label>
      </div>

      <div class="chat-input-area">
        <textarea
          value={input}
          onInput={(e) => handleInputChange((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Lumen anything..."
          rows={1}
          disabled={loading}
        />
        <button onClick={send} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </>
  );
}
