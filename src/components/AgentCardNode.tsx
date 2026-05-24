import { useState, memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';

const STATUS_EMOJI: Record<string, string> = {
  working: '🟢',
  idle: '⚪',
  offline: '🔴',
};

const TYPE_EMOJI: Record<string, string> = {
  host: '🖥️',
  coordinator: '👑',
  server: '🔌',
  agent: '🤖',
  cli: '💻',
};

const TYPE_LABELS: Record<string, string> = {
  host: 'Host',
  coordinator: 'Coordinator',
  server: 'Server',
  agent: 'Agent',
  cli: 'CLI',
};

function AgentCardNode({ data, id }: NodeProps) {
  const [expanded, setExpanded] = useState(false);
  const label = (data.label as string) || id;
  const status = (data.status as string) || 'idle';
  const agentType = (data.agentType as string) || 'agent';
  const cwd = (data.cwd as string) || '~/';
  const lastSeen = (data.lastSeen as string) || '—';

  const emoji = TYPE_EMOJI[agentType] || '🤖';
  const typeLabel = TYPE_LABELS[agentType] || agentType;
  const statusDot = STATUS_EMOJI[status] || '⚪';

  // 从 label 中提取纯名称（去掉 emoji 和换行）
  const nameLine = label.split('\n')[0].replace(/^[^\w]*/, '').trim() || id;

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      style={{
        minWidth: expanded ? 220 : 140,
        maxWidth: expanded ? 300 : 180,
        background: '#1e1e1e',
        border: `1.5px solid ${status === 'working' ? '#00cc66' : status === 'offline' ? '#666' : '#4a90e2'}`,
        borderRadius: 10,
        padding: expanded ? '12px 14px' : '8px 12px',
        cursor: 'pointer',
        transition: 'all 0.25s ease',
        boxShadow: status === 'working'
          ? '0 0 12px rgba(0,204,102,0.3)'
          : '0 2px 8px rgba(0,0,0,0.3)',
        userSelect: 'none',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#4a90e2' }} />

      {/* 折叠态：emoji + 名称 + 状态点 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 20 }}>{emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: '#e0e0e0', fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {nameLine}
          </div>
          <div style={{ color: '#888', fontSize: 11 }}>
            {statusDot} {status} · {typeLabel}
          </div>
        </div>
      </div>

      {/* 展开态：详细信息 */}
      {expanded && (
        <div style={{ marginTop: 10, borderTop: '1px solid #333', paddingTop: 8 }}>
          <div style={{ color: '#aaa', fontSize: 11, marginBottom: 3 }}>
            📂 {cwd}
          </div>
          <div style={{ color: '#888', fontSize: 10 }}>
            🕐 {lastSeen}
          </div>
          <div style={{
            marginTop: 8,
            padding: '4px 10px',
            background: 'rgba(74,144,226,0.15)',
            borderRadius: 6,
            color: '#4a90e2',
            fontSize: 11,
            textAlign: 'center',
          }}>
            双击打开终端
          </div>
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ background: '#4a90e2' }} />
    </div>
  );
}

export default memo(AgentCardNode);
