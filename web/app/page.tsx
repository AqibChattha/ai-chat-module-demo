'use client';

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const MAX_CHARS = 4000;

type Msg = { id: string; role: 'user' | 'assistant'; content: string; status?: 'complete' | 'stopped' };
type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'done'; messageId: number; status: 'complete' | 'stopped' }
  | { type: 'error'; message: string };

/** Reads an SSE body from fetch (EventSource cannot POST) and yields parsed events. */
async function* readSse(res: Response): AsyncGenerator<StreamEvent> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = block.split('\n').find((l) => l.startsWith('data: '));
      if (data) yield JSON.parse(data.slice(6));
    }
  }
}

export default function Chat() {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const newConversation = useCallback(async () => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    const res = await fetch(`${API}/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) return setError('Could not start a conversation. Is the API running?');
    const conv = await res.json();
    setConversationId(conv.id);
    localStorage.setItem('conversationId', conv.id);
  }, []);

  // Restore the last conversation (history comes from PostgreSQL), or start a new one.
  useEffect(() => {
    const saved = localStorage.getItem('conversationId');
    if (!saved) {
      newConversation();
      return;
    }
    fetch(`${API}/conversations/${saved}/messages`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((rows: Array<{ id: number; role: Msg['role']; content: string; status: Msg['status'] }>) => {
        setConversationId(saved);
        setMessages(rows.map((r) => ({ id: String(r.id), role: r.role, content: r.content, status: r.status })));
      })
      .catch(() => newConversation());
  }, [newConversation]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  async function send(text: string) {
    if (!conversationId || !text.trim() || streaming) return;
    setError(null);
    setLastPrompt(text);
    const assistantId = `pending-${Date.now()}`;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, role: 'user', content: text }, { id: assistantId, role: 'assistant', content: '' }]);
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;

    const update = (fn: (m: Msg) => Msg) => setMessages((all) => all.map((m) => (m.id === assistantId ? fn(m) : m)));

    try {
      const res = await fetch(`${API}/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
        signal: abort.signal,
      });
      if (res.status === 429) throw new Error('Too many messages. Wait a minute and retry.');
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message?.toString() ?? `Request failed (${res.status})`);

      for await (const event of readSse(res)) {
        if (event.type === 'token') update((m) => ({ ...m, content: m.content + event.text }));
        if (event.type === 'done') update((m) => ({ ...m, status: event.status }));
        if (event.type === 'error') throw new Error(event.message);
      }
    } catch (err: any) {
      if (abort.signal.aborted) {
        update((m) => ({ ...m, status: 'stopped' }));
      } else {
        setMessages((all) => all.filter((m) => m.id !== assistantId || m.content));
        setError(err?.message ?? 'Something went wrong.');
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    setInput('');
    send(text);
  }

  return (
    <main className="app">
      <header>
        <h1>AI Assistant</h1>
        <button onClick={newConversation} disabled={streaming}>New chat</button>
      </header>

      <div className="log" ref={logRef} aria-live="polite">
        {messages.length === 0 && <p className="empty">Ask anything. Replies stream in as they are written.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <span className={streaming && m.id.startsWith('pending') && m.status === undefined ? 'cursor' : ''}>{m.content}</span>
            {m.status === 'stopped' && <span className="note">Stopped. The partial reply was saved.</span>}
          </div>
        ))}
        {error && (
          <div className="error" role="alert">
            {error}
            {lastPrompt && (
              <button className="btn secondary" onClick={() => send(lastPrompt)}>Retry</button>
            )}
          </div>
        )}
      </div>

      <form onSubmit={onSubmit}>
        <textarea
          value={input}
          maxLength={MAX_CHARS}
          placeholder="Type a message (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) onSubmit(e);
          }}
          disabled={!conversationId}
        />
        {streaming ? (
          <button type="button" className="btn secondary" onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button type="submit" className="btn" disabled={!input.trim() || !conversationId}>Send</button>
        )}
      </form>
      <span className="count">{input.length}/{MAX_CHARS}</span>
    </main>
  );
}
