import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import '@xterm/xterm/css/xterm.css';

interface TerminalNodeProps {
  cwd: string;
}

export default function TerminalNode({ cwd }: TerminalNodeProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

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

    // 强制焦点：解决 Tauri WebView 吞键盘事件的问题
    term.focus();
    // 点击终端区域时重新夺取焦点
    term.element?.addEventListener('click', () => term.focus());
    // 拦截全局键盘事件确保不会逃逸到画布
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') {
        term.focus();
      }
      return true;
    });

    term.writeln('\x1b[36m[Ocean Stream]\x1b[0m 欢迎进入隔离工作区');
    term.writeln(`\x1b[36m[CWD Lock]\x1b[0m 目录已锁定: ${cwd}`);
    term.writeln('\x1b[33m[Interceptor]\x1b[0m API 网关流量劫持已就绪...\r\n');

    // 键盘输入 → IPC → Rust PTY
    term.onData((data) => {
      invoke('write_pty', { input: data }).catch((err) => {
        term.writeln(`\x1b[31m[IPC Error]\x1b[0m write_pty 失败: ${err}`);
      });
    });

    // 监听 Rust PTY 输出
    const unlistenPromise = listen<string>('pty-output', (event) => {
      term.write(event.payload);
    });

    // 通知 Rust 派生 PTY 进程
    invoke('spawn_pty', { cwd })
      .then(() => {
        term.writeln('\x1b[32m[OK]\x1b[0m PTY 进程已启动');
        term.focus();
      })
      .catch((err) => {
        term.writeln(`\x1b[31m[Fatal]\x1b[0m 无法启动 PTY: ${err}`);
      });

    return () => {
      term.dispose();
      unlistenPromise.then((fn) => fn());
    };
  }, [cwd]);

  return (
    <div style={{ padding: 10, background: '#1e1e1e', borderRadius: 8, height: '100%' }}>
      <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8, userSelect: 'none' }}>
        ⚙️ Ocean-Aider (Sandboxed) — 点击终端区域后直接输入
      </div>
      <div ref={terminalRef} style={{ height: '300px', width: '100%' }} />
    </div>
  );
}