import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
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
import AgentCardNode from './components/AgentCardNode';
import GlowEdge from './components/GlowEdge';
import { restorePositions, useCanvasPersistence } from './hooks/useCanvasPersistence';

// ── 自定义节点/边类型 ──
const nodeTypes = { agentCard: AgentCardNode };
const edgeTypes = { glow: GlowEdge };

// 初始连线（使用 GlowEdge）
const FIXED_EDGES: Edge[] = [
  { id: 'e1-2', source: 'desktop', target: 'ruflo-queen', type: 'glow', data: { status: 'idle' }, style: { stroke: '#4a90e2', strokeWidth: 2 } },
  { id: 'e2-3', source: 'ruflo-queen', target: 'ocean-mcp', type: 'glow', data: { status: 'idle' } },
];

interface AgentRecord {
  id: string;
  name: string;
  agent_type: string;
  status: string;
  last_seen: string;
}

const STATUS_LABELS: Record<string, string> = {
  working: 'working',
  idle: 'idle',
  offline: 'offline',
};

function agentToNode(a: AgentRecord, savedPos?: { x: number; y: number }): Node {
  return {
    id: a.id,
    type: 'agentCard',
    position: savedPos || {
      x: 100 + Math.random() * 300,
      y: 100 + Math.random() * 200,
    },
    data: {
      label: `${a.name}`,
      status: STATUS_LABELS[a.status] || 'idle',
      agentType: a.agent_type,
      cwd: a.id === 'desktop' ? '~/' : `~/projects/ocean/${a.id}`,
      lastSeen: a.last_seen || '—',
    },
  };
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(FIXED_EDGES);
  const [activeTerminal, setActiveTerminal] = useState<{ nodeId: string; cwd: string } | null>(null);

  // ── 画布布局持久化 ──
  useCanvasPersistence(nodes);

  // ── 启动时从 SQLite 账本加载 Agent 列表 ──
  useEffect(() => {
    invoke<AgentRecord[]>('get_agents')
      .then((agents) => {
        const restored = restorePositions(agents.map((a) => agentToNode(a)));
        setNodes(restored);
      })
      .catch(() => {
        const fallback = [
          agentToNode({ id: 'desktop', name: 'Desktop', agent_type: 'host', status: 'idle', last_seen: '' }),
          agentToNode({ id: 'ruflo-queen', name: 'Ruflo Queen', agent_type: 'coordinator', status: 'idle', last_seen: '' }),
          agentToNode({ id: 'ocean-mcp', name: 'Ocean MCP', agent_type: 'server', status: 'idle', last_seen: '' }),
        ];
        setNodes(restorePositions(fallback));
      });
  }, [setNodes]);

  // ── 监听拦截网关事件 ──
  useEffect(() => {
    const unlisten = listen<{ agent_id: string; prompt: string; model: string }>('gateway-intercept', (event) => {
      const { agent_id, prompt, model } = event.payload;

      setNodes((nds) => {
        const exists = nds.some((n) => n.id === agent_id);
        if (!exists) {
          nds = [...nds, agentToNode({
            id: agent_id, name: agent_id,
            agent_type: 'cli', status: 'working',
            last_seen: new Date().toISOString(),
          })];
        }
        return nds.map((node) => {
          if (node.id === agent_id) {
            return {
              ...node,
              data: {
                ...node.data,
                status: 'working',
                label: `${node.id}\n[API] ${model}\n${prompt.substring(0, 30)}...`,
              },
            };
          }
          return node;
        });
      });

      // 同步更新连线状态
      setEdges((eds) => eds.map((e) => ({
        ...e,
        data: { ...e.data, status: 'working' },
      })));

      setTimeout(() => {
        invoke('update_agent_status', { agentId: agent_id, status: 'idle' }).catch(() => {});
        setNodes((nds) =>
          nds.map((node) =>
            node.id === agent_id
              ? { ...node, data: { ...node.data, status: 'idle' } }
              : node
          )
        );
        setEdges((eds) => eds.map((e) => ({
          ...e,
          data: { ...e.data, status: 'idle' },
        })));
      }, 3000);
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [setNodes, setEdges]);

  // ── 监听 Ruflo 桥接同步事件 ──
  useEffect(() => {
    const unlisten = listen<{ count: number }>('agents-synced', () => {
      invoke<AgentRecord[]>('get_agents')
        .then((agents) => {
          const restored = restorePositions(agents.map((a) => agentToNode(a)));
          setNodes(restored);
        })
        .catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [setNodes]);

  // ── 监听 PTY 进程退出 ──
  useEffect(() => {
    const unlisten = listen<string>('pty-exit', () => {
      setActiveTerminal(null);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 关闭终端 + 清理 PTY
  const closeTerminal = useCallback(() => {
    invoke('kill_pty').catch(() => {});
    setActiveTerminal(null);
  }, []);

  // 手动刷新 Ruflo
  const handleRefresh = useCallback(() => {
    invoke<number>('refresh_agents')
      .then((n) => console.log(`[Ocean] 手动刷新完成，${n} 个 agent`))
      .catch((e) => console.warn('[Ocean] 刷新失败:', e));
  }, []);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const cwd = (node.data as Record<string, string>)?.cwd || '~/';
      setActiveTerminal({ nodeId: node.id, cwd });
    },
    [],
  );

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#1e1e1e', position: 'relative' }}>
      {/* 顶部工具栏 */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 200,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '8px 16px', background: 'rgba(30,30,30,0.95)',
        borderBottom: '1px solid #333', backdropFilter: 'blur(8px)',
      }}>
        <span style={{ color: '#4a90e2', fontWeight: 'bold', fontSize: 16 }}>
          🌊 Ocean Stream v0.5.0
        </span>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: 12 }}>
            {nodes.length} agents · Phase 2 · 💬/⌨️
          </span>
          <button onClick={handleRefresh}
            style={{
              background: '#2d2d2d', border: '1px solid #4a90e2', color: '#4a90e2',
              padding: '4px 14px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
            }}>
            🔄 同步 Ruflo
          </button>
        </span>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeDoubleClick={onNodeDoubleClick}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        colorMode="dark"
        defaultEdgeOptions={{ type: 'glow' }}
      >
        <Controls />
        <MiniMap
          nodeStrokeColor={(n) => {
            const s = (n.data as { status?: string })?.status;
            return s === 'working' ? '#00cc66' : s === 'offline' ? '#666' : '#4a90e2';
          }}
          nodeColor={(n) => {
            const s = (n.data as { status?: string })?.status;
            return s === 'working' ? '#1a3a1a' : s === 'offline' ? '#1a1a1a' : '#1a1a2e';
          }}
        />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      </ReactFlow>

      {activeTerminal && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: '45%',
          background: '#1a1a1a', borderTop: '2px solid #4a90e2', zIndex: 100,
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 16px', background: '#2d2d2d', borderBottom: '1px solid #444',
          }}>
            <span style={{ color: '#4a90e2', fontWeight: 'bold', fontSize: 14 }}>
              ⬇ L2 工作区 — {activeTerminal.nodeId} | 📂 {activeTerminal.cwd}
            </span>
            <button onClick={closeTerminal}
              style={{
                background: 'transparent', border: '1px solid #666', color: '#ccc',
                padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
              }}>
              ✖ 关闭
            </button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', padding: 10 }}>
            <TerminalNode cwd={activeTerminal.cwd} />
          </div>
        </div>
      )}
    </div>
  );
}
