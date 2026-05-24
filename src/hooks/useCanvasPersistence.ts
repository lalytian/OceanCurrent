import { useEffect } from 'react';
import type { Node } from '@xyflow/react';

const STORAGE_KEY = 'ocean-stream-canvas-layout';

interface SavedLayout {
  positions: Record<string, { x: number; y: number }>;
  viewport: { x: number; y: number; zoom: number } | null;
}

function loadLayout(): SavedLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { positions: {}, viewport: null };
  } catch {
    return { positions: {}, viewport: null };
  }
}

function saveLayout(nodes: Node[]) {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    positions[n.id] = n.position;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ positions, viewport: null }));
}

/** 从 localStorage 恢复节点的 X/Y 坐标 */
export function restorePositions(nodes: Node[]): Node[] {
  const saved = loadLayout();
  if (Object.keys(saved.positions).length === 0) return nodes;

  return nodes.map((n) => {
    const pos = saved.positions[n.id];
    return pos ? { ...n, position: pos } : n;
  });
}

/** 监听 nodes 变化，自动保存位置到 localStorage */
export function useCanvasPersistence(nodes: Node[]) {
  useEffect(() => {
    const timer = setTimeout(() => saveLayout(nodes), 500);
    return () => clearTimeout(timer);
  }, [nodes]);
}
