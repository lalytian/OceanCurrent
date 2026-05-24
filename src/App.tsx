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

// 节点样式映射
const STYLE_HOST = { border: '2px solid #333', background: '#f8f9fa', color: '#333' };
const STYLE_COORD = { border: '2px solid #4a90e2', background: '#e3f2fd', color: '#1565c0' };
const STYLE_SERVER = { border: '2px dashed #ff9800', background: '#fff3e0' };
const STYLE_CLI = { border: '2px solid #00cc66', background: '#e8f5e9', color: '#2e7d32' };
const STYLE_OFFLINE = { border: '2px dashed #999', background: '#f5f5f5', color: '#999' };

// 初始连线
const FIXED_EDGES: Edge[] = [
  { id: 'e1-2', source: 'desktop', target: 'ruflo-queen', animated: true, style: { stroke: '#4a90e2', strokeWidth: 2 } },
  { id: 'e2-3', source: 'ruflo-queen', target: 'ocean-mcp', animated: true },
];

interface AgentRecord {
  id: string;
  name: string;
  agent_type: string;
  status: string;
  last_seen: string;
}

function agentToNode(a: AgentRecord): Node {
  const style =
    a.status === 'offline' ? STYLE_OFFLINE :
    a.agent_type === 'host' ? STYLE_HOST :
    a.agent_type === 'coordinator' ? STYLE_COORD :
    a.agent_type === 'server' ? STYLE_SERVER :
    a.agent_type === 'cli' ? STYLE_CLI : STYLE_HOST;

  const emoji =
    a.agent_type === 'host' ? '🖥️' :
    a.agent_type === 'coordinator' ? '👑' :
    a.agent_type === 'server' ? '🔌' :
    a.agent_type === 'cli' ? '💻' : '🤖';

  return {
    id: a.id,
    type: 'default',
    position: { 
      x: 100 + Math.random() * 300, 
      y: 100 + Math.random() * 200 
    },
    data: { 
      label: `${emoji} ${a.name}\n[${a.status}] 双击打开终端`,
      cwd: a.id === 'desktop' ? '~/' : `~/projects/ocean/${a.id}`,
    },
    style,
  };
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(FIXED_EDGES);
  const [activeTerminal, setActiveTerminal] = useState<{ nodeId: string; cwd: string } | null>(null);

  // ── 启动时从 SQLite 账本加载 Agent 列表 ──
  useEffect(() => {
    invoke<AgentRecord[]>('get_agents')
      .then((agents) => {
        setNodes(agents.map(agentToNode));
      })
      .catch(() => {
        // 回退：如果 Rust 层还没就绪，用硬编码节点
        setNodes([
          agentToNode({ id: 'desktop', name: 'Desktop', agent_type: 'host', status: 'idle', last_seen: '' }),
          agentToNode({ id: 'ruflo-queen', name: 'Ruflo Queen', agent_type: 'coordinator', status: 'idle', last_seen: '' }),
          agentToNode({ id: 'ocean-mcp', name: 'Ocean MCP', agent_type: 'server', status: 'idle', last_seen: '' }),
        ]);
      });
  }, [setNodes]);

  // ── 监听拦截网关事件 ──
  useEffect(() => {
    const unlisten = listen<{ agent_id: string; prompt: string; model: string }>('gateway-intercept', (event) => {
      const { agent_id, prompt, model } = event.payload;

      // 刷新画布节点：标记该 agent 为 working，闪烁绿色
      setNodes((nds) => {
        const exists = nds.some((n) => n.id === agent_id);
        if (!exists) {
          // 新发现的 CLI agent — 动态加入画布
          nds = [...nds, agentToNode({
            id: agent_id,
            name: agent_id,
            agent_type: 'cli',
            status: 'working',
            last_seen: new Date().toISOString(),
          })];
        }
        return nds.map((node) => {
          if (node.id === agent_id) {
            return {
              ...node,
              data: {
                ...node.data,
                label: `💻 ${node.id}\n[API] ${model}\n${prompt.substring(0, 30)}...`,
              },
              style: { ...node.style, borderColor: '#00ff00', boxShadow: '0 0 15px #00ff00' },
            };
          }
          return node;
        });
      });

      // 3秒后恢复
      setTimeout(() => {
        invoke('update_agent_status', { agentId: agent_id, status: 'idle' }).catch(() => {});
        setNodes((nds) =>
          nds.map((node) => {
            if (node.id === agent_id) {
              return {
                ...node,
                data: {
                  ...node.data,
                  label: `💻 ${node.id}\n[idle] 双击打开终端`,
                },
                style: { ...node.style, borderColor: STYLE_CLI.border, boxShadow: 'none' },
              };
            }
            return node;
          })
        );
      }, 3000);
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [setNodes]);

  // ── 监听 Ruflo 桥接同步事件 ──
  useEffect(() => {
    const unlisten = listen<{ count: number }>('agents-synced', (_event) => {
      // 桥接同步完成 → 重新加载 Agent 列表
      invoke<AgentRecord[]>('get_agents')
        .then((agents) => setNodes(agents.map(agentToNode)))
        .catch(() => {});
    });

    return () => { unlisten.then((fn) => fn()); };
  }, [setNodes]);

  // 手动刷新按钮
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
          🌊 Ocean Stream v0.4.0
        </span>
        <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: '#888', fontSize: 12 }}>
            {nodes.length} agents · Bridge: MCP (HTTP)
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
        fitView
        colorMode="dark"
      >
        <Controls />
        <MiniMap nodeStrokeColor={(n) => (n.style?.background as string) || '#fff'}
                 nodeColor={(n) => (n.style?.background as string) || '#fff'} />
        <Background variant={BackgroundVariant.Dots} gap={12} size={1} />
      </ReactFlow>

      {activeTerminal && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0, height: '45%',
          background: '#1a1a1a', borderTop: '2px solid #4a90e2', zIndex: 100,
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 16px', background: '#2d2d2d', borderBottom: '1px solid #444' }}>
            <span style={{ color: '#4a90e2', fontWeight: 'bold', fontSize: 14 }}>
              ⬇ L2 工作区 — {activeTerminal.nodeId} | 📂 {activeTerminal.cwd}
            </span>
            <button onClick={() => setActiveTerminal(null)}
              style={{ background: 'transparent', border: '1px solid #666', color: '#ccc', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>
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