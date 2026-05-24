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

    // 1. 初始化前端 XTerm 沙盒实例
    const term = new Terminal({
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();
    xtermRef.current = term;

    term.writeln('\x1b[36m[Ocean Stream]\x1b[0m 欢迎进入隔离工作区');
    term.writeln(`\x1b[36m[CWD Lock]\x1b[0m 目录已锁定: ${cwd}`);
    term.writeln('\x1b[33m[Interceptor]\x1b[0m API 网关流量劫持已准备就绪...\r\n');

    // 2. 将键盘敲击通过 IPC 发送给 Rust PTY
    term.onData((data) => {
      invoke('write_pty', { input: data });
    });

    // 3. 监听来自 Rust PTY 的底层日志输出
    const unlisten = listen<string>('pty-output', (event) => {
      term.write(event.payload);
    });

    // 4. 通知 Rust 派生该工作区的独立 PTY 进程
    invoke('spawn_pty', { cwd }).catch((err) => {
      term.writeln(`\x1b[31m[Error]\x1b[0m 无法启动终端进程: ${err}`);
    });

    return () => {
      term.dispose();
      unlisten.then((fn) => fn());
    };
  }, [cwd]);

  return (
    <div style={{ padding: 10, background: '#1e1e1e', borderRadius: 8, height: '100%' }}>
      <div style={{ color: '#aaa', fontSize: 12, marginBottom: 8, userSelect: 'none' }}>
        ⚙️ Ocean-Aider (Sandboxed)
      </div>
      <div ref={terminalRef} style={{ height: '300px', width: '500px' }} />
    </div>
  );
}