import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';
import SessionBubble from './SessionBubble';

interface TerminalNodeProps {
  cwd: string;
}

export default function TerminalNode({ cwd }: TerminalNodeProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const [view, setView] = useState<'terminal' | 'bubbles'>('terminal');

  useEffect(() => {
    if (view !== 'terminal' || !terminalRef.current) return;

    const term = new Terminal({
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    xtermRef.current = term;

    term.focus();
    term.element?.addEventListener('click', () => term.focus());
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') term.focus();
      return true;
    });

    term.writeln('\x1b[36m[Ocean Stream]\x1b[0m 欢迎进入隔离工作区');
    term.writeln(`\x1b[36m[CWD Lock]\x1b[0m 目录已锁定: ${cwd}`);
    term.writeln('\x1b[33m[Interceptor]\x1b[0m API 网关流量劫持已就绪...\r\n');

    term.onData((data) => {
      invoke('write_pty', { input: data }).catch((err) => {
        term.writeln(`\x1b[31m[IPC Error]\x1b[0m write_pty 失败: ${err}`);
      });
    });

    const unlistenPromise = listen<string>('pty-output', (event) => {
      term.write(event.payload);
    });

    invoke('spawn_pty', { cwd })
      .then(() => term.writeln('\x1b[32m[OK]\x1b[0m PTY 进程已启动'))
      .catch((err) => term.writeln(`\x1b[31m[Fatal]\x1b[0m 无法启动 PTY: ${err}`));

    return () => {
      term.dispose();
      unlistenPromise.then((fn) => fn());
    };
  }, [cwd, view]);

  return (
    <div style={{ padding: 10, background: '#1e1e1e', borderRadius: 8, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 8, userSelect: 'none',
      }}>
        <span style={{ color: '#aaa', fontSize: 12 }}>
          ⚙️ Ocean-Aider (Sandboxed)
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => setView('bubbles')}
            style={{
              background: view === 'bubbles' ? '#4a90e2' : '#2d2d2d',
              border: '1px solid #444',
              color: view === 'bubbles' ? '#fff' : '#888',
              padding: '2px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
            }}
          >
            💬 会话
          </button>
          <button
            onClick={() => setView('terminal')}
            style={{
              background: view === 'terminal' ? '#4a90e2' : '#2d2d2d',
              border: '1px solid #444',
              color: view === 'terminal' ? '#fff' : '#888',
              padding: '2px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 11,
            }}
          >
            ⌨️ 终端
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'hidden' }}>
        {view === 'bubbles' ? (
          <SessionBubble />
        ) : (
          <div ref={terminalRef} style={{ height: '100%', width: '100%' }} />
        )}
      </div>
    </div>
  );
}
