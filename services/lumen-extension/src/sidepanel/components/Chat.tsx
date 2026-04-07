import { useState, useEffect, useRef } from 'preact/hooks';
import type { ChatMessage } from '../../shared/types';

export function Chat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [includeContext, setIncludeContext] = useState(true);
  const messagesEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_CHAT_HISTORY' }).then((res: any) => {
      if (res?.type === 'CHAT_HISTORY') setMessages(res.payload);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput('');
    setLoading(true);

    // Optimistic user message
    const userMsg: ChatMessage = { role: 'user', content: text, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);

    try {
      const res: any = await chrome.runtime.sendMessage({
        type: 'CHAT_SEND',
        payload: { message: text, includePageContext: includeContext },
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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
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

      <div class="context-toggle">
        <input
          type="checkbox"
          id="ctx"
          checked={includeContext}
          onChange={(e) => setIncludeContext((e.target as HTMLInputElement).checked)}
        />
        <label for="ctx">Include page context</label>
      </div>

      <div class="chat-input-area">
        <textarea
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
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
