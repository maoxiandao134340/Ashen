export type MemoryLayer = 'deep' | 'daily' | 'diary' | 'writing';

export interface Memory {
  id: string;
  content: string;
  layer: MemoryLayer;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string; // 只有 daily 层有
}

export interface MemoryStats {
  total: number;
  byLayer: Record<MemoryLayer, number>;
  newestMemory?: string;
  oldestMemory?: string;
}
