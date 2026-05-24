import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

interface BubbleMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  time: string;
  streaming?: boolean;
}

export default function SessionBubble() {
  const [messages, setMessages] = useState<BubbleMessage[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisten = listen<{ agent_id: string; prompt: string; model: string }>(
      'gateway-intercept',
      (event) => {
        const { prompt, model } = event.payload;

        const userMsg: BubbleMessage = {
          id: `u-${Date.now()}`,
          role: 'user',
          content: prompt,
          model,
          time: new Date().toLocaleTimeString(),
        };

        // 模拟流式响应（拦截网关当前返回 mock 响应）
        const aiId = `a-${Date.now()}`;
        const aiMsg: BubbleMessage = {
          id: aiId,
          role: 'assistant',
          content: '',
          model,
          time: new Date().toLocaleTimeString(),
          streaming: true,
        };

        setMessages((prev) => [...prev, userMsg, aiMsg]);

        // 逐字流式显示
        const text = `(Ocean Ledger 已记录)\n> ${prompt.substring(0, 60)}${prompt.length > 60 ? '...' : ''}`;
        let i = 0;
        const interval = setInterval(() => {
          i++;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiId
                ? { ...m, content: text.substring(0, i), streaming: i < text.length }
                : m
            )
          );
          if (i >= text.length) clearInterval(interval);
        }, 25);
      }
    );

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '12px 16px' }}>
      {messages.length === 0 && (
        <div style={{
          color: '#666', textAlign: 'center', marginTop: '40%',
          fontSize: 14, lineHeight: 1.8,
        }}>
          🌊 会话气泡视图<br />
          <span style={{ fontSize: 12, color: '#888' }}>
            通过 CLI 执行 <code style={{ color: '#4a90e2' }}>ocean-aider</code> 后，<br />
            API 调用将在此实时呈现。
          </span>
        </div>
      )}

      {messages.map((msg) => (
        <div
          key={msg.id}
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
            marginBottom: 12,
          }}
        >
          {/* 角色标签 */}
          <div style={{ color: '#888', fontSize: 10, marginBottom: 2, padding: '0 4px' }}>
            {msg.role === 'user' ? '🧑 You' : msg.role === 'assistant' ? '🤖 AI' : '⚙️ System'}
            {msg.model && <span style={{ marginLeft: 6, color: '#666' }}>{msg.model}</span>}
            <span style={{ marginLeft: 6, color: '#555' }}>{msg.time}</span>
          </div>

          {/* 气泡 */}
          <div style={{
            maxWidth: '85%',
            padding: '10px 14px',
            borderRadius: 14,
            borderBottomRightRadius: msg.role === 'user' ? 4 : 14,
            borderBottomLeftRadius: msg.role === 'assistant' ? 4 : 14,
            background: msg.role === 'user'
              ? '#1a3a5c'
              : msg.role === 'assistant'
                ? '#1e2a1e'
                : '#2a1a2e',
            border: `1px solid ${
              msg.role === 'user' ? '#4a90e2' :
              msg.role === 'assistant' ? '#00cc66' : '#ff9800'
            }`,
            color: '#d4d4d4',
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontFamily: msg.role === 'assistant' ? 'Menlo, Monaco, "Courier New", monospace' : 'inherit',
          }}>
            {/* Markdown 内联代码 */}
            {msg.content.split(/(`[^`]+`)/).map((part, i) =>
              part.startsWith('`') ? (
                <code key={i} style={{
                  background: 'rgba(255,255,255,0.1)',
                  padding: '1px 5px',
                  borderRadius: 3,
                  color: '#4a90e2',
                  fontSize: 12,
                }}>
                  {part.replace(/`/g, '')}
                </code>
              ) : (
                <span key={i}>{part}</span>
              )
            )}

            {/* 流式光标 */}
            {msg.streaming && (
              <span style={{
                display: 'inline-block',
                width: 8, height: 14,
                background: '#00cc66',
                marginLeft: 2,
                animation: 'blink 0.8s infinite',
                verticalAlign: 'middle',
              }} />
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />

      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </div>
  );
}
