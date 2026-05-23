import { useCallback } from 'react';
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

// 初始占位节点 (L1 拓扑演示)
const initialNodes: Node[] = [
  { id: 'desktop', position: { x: 100, y: 100 }, data: { label: '🖥️ Desktop (Local-Device)' }, style: { border: '2px solid #333', background: '#f8f9fa', color: '#333' } },
  { id: 'ruflo-queen', position: { x: 100, y: 250 }, data: { label: '👑 Ruflo Queen Coordinator' }, style: { border: '2px solid #4a90e2', background: '#e3f2fd', color: '#1565c0' } },
  { id: 'ocean-mcp', position: { x: 350, y: 175 }, data: { label: '🔌 Ocean MCP Server' }, style: { border: '2px dashed #ff9800', background: '#fff3e0' } },
];

// 初始连线
const initialEdges: Edge[] = [
  { id: 'e1-2', source: 'desktop', target: 'ruflo-queen', animated: true, style: { stroke: '#4a90e2', strokeWidth: 2 } },
  { id: 'e2-3', source: 'ruflo-queen', target: 'ocean-mcp', animated: true },
];

export default function App() {
  const [nodes, , onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  return (
    <div style={{ width: '100vw', height: '100vh', backgroundColor: '#1e1e1e' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
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
    </div>
  );
}