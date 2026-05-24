import { BaseEdge, getBezierPath } from '@xyflow/react';
import type { EdgeProps } from '@xyflow/react';

const GLOW_COLORS: Record<string, string> = {
  idle: '#4a90e2',
  working: '#00cc66',
  offline: '#666',
  default: '#4a90e2',
};

export default function GlowEdge({
  id,
  sourceX, sourceY,
  targetX, targetY,
  sourcePosition, targetPosition,
  style = {},
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  });

  const status = (data as { status?: string })?.status || 'idle';
  const color = GLOW_COLORS[status] || GLOW_COLORS.default;

  return (
    <>
      {/* 底层发光 */}
      <path
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={4}
        strokeOpacity={0.15}
        style={{ filter: `blur(4px)` }}
      />
      {/* 中层光晕 */}
      <path
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeOpacity={0.4}
        style={{ filter: `blur(2px)` }}
      />
      {/* 前景线 + 虚线流动动画 */}
      <path
        d={edgePath}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="6 4"
        style={{
          ...style,
          stroke: color,
          animation: `dashFlow 1.5s linear infinite`,
          animationPlayState: status === 'offline' ? 'paused' : 'running',
        }}
        markerEnd={markerEnd}
      />
      <style>{`
        @keyframes dashFlow {
          from { stroke-dashoffset: 20; }
          to   { stroke-dashoffset: 0; }
        }
      `}</style>
    </>
  );
}
