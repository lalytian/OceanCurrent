import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  addEdge,
} from '@xyflow/react';
import type { Connection, Edge, Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import TerminalNode from './components/TerminalNode';

// 初始占位节点 (L1 拓扑演示)
const initialNodes: Node[] = [
  { id: 'desktop', type: 'default', position: { x: 100, y: 100 }, data: { label: '🖥️ Desktop (双击打开终端)', cwd: '~/' }, style: { border: '2px solid #333', background: '#f8f9fa', color: '#333' } },
  { id: 'ruflo-queen', type: 'default', position: { x: 100, y: 250 }, data: { label: '👑 Ruflo Queen Coordinator' }, style: { border: '2px solid #4a90e2', background: '#e3f2fd', color: '#1565c0' } },
  { id: 'ocean-mcp', type: 'default', position: { x: 350, y: 175 }, data: { label: '🔌 Ocean MCP Server' }, style: { border: '2px dashed #ff9800', background: '#fff3e0' } },
];

// 初始连线
const initialEdges: Edge[] = [
  { id: 'e1-2', source: 'desktop', target: 'ruflo-queen', animated: true, style: { stroke: '#4a90e2', strokeWidth: 2 } },
  { id: 'e2-3', source: 'ruflo-queen', target: 'ocean-mcp', animated: true },
];

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [activeTerminal, setActiveTerminal] = useState<{ nodeId: string; cwd: string } | null>(null);

  // 监听来自 Rust 本地拦截网关的事件
  useEffect(() => {
    const unlisten = listen<{ agent_id: string; prompt: string; model: string }>('gateway-intercept', (event) => {
      const { prompt, model } = event.payload;
      console.log('Intercepted:', event.payload);
      
      setNodes((nds) => 
        nds.map((node) => {
          if (node.id === 'desktop') {
            return {
              ...node,
              data: { 
                ...node.data,
                label: `🖥️ Desktop\n\n[拦截到 API 请求]\n模型: ${model}\nPrompt: ${prompt.substring(0, 20)}...` 
              },
              style: { ...node.style, borderColor: '#00ff00', boxShadow: '0 0 15px #00ff00' }
            };
          }
          return node;
        })
      );

      setTimeout(() => {
        setNodes((nds) =>
          nds.map((node) => {
            if (node.id === 'desktop') {
              return {
                ...node,
                data: { ...node.data, label: '🖥️ Desktop (双击打开终端)' },
                style: { ...node.style, borderColor: '#333', boxShadow: 'none' }
              };
            }
            return node;
          })
        );
      }, 3000);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setNodes]);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  // 双击节点 → 打开该节点绑定的隔离终端抽屉
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const cwd = (node.data as Record<string, string>)?.cwd || '~/';
      setActiveTerminal({ nodeId: node.id, cwd });
    },
    [],
  );

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#1e1e1e', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDoubleClick={onNodeDoubleClick}
        fitView
        colorMode="dark"
      >
        <Controls />
        <MiniMap nodeStrokeColor={(n) => {
            if (n.style?.background) return n.style.background as string;
            return '#fff';
        }} nodeColor={(n) => {
            if (n.style?.background) return n.style.background as string;
            return '#fff';
        }} />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      </ReactFlow>

      {/* L2 抽屉层：终端沙盒 */}
      {activeTerminal && (
        <div style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: '45%',
          background: '#1a1a1a',
          borderTop: '2px solid #4a90e2',
          zIndex: 100,
          display: 'flex',
          flexDirection: 'column',
        }}>
          {/* 抽屉标题栏 */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '8px 16px',
            background: '#2d2d2d',
            borderBottom: '1px solid #444',
          }}>
            <span style={{ color: '#4a90e2', fontWeight: 'bold', fontSize: 14 }}>
              ⬇ L2 节点工作区 — 绑定: {activeTerminal.nodeId} | 📂 CWD: {activeTerminal.cwd}
            </span>
            <button
              onClick={() => setActiveTerminal(null)}
              style={{
                background: 'transparent',
                border: '1px solid #666',
                color: '#ccc',
                padding: '4px 12px',
                borderRadius: 4,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              ✖ 关闭
            </button>
          </div>
          {/* 终端区域 */}
          <div style={{ flex: 1, overflow: 'hidden', padding: 10 }}>
            <TerminalNode cwd={activeTerminal.cwd} />
          </div>
        </div>
      )}
    </div>
  );
}