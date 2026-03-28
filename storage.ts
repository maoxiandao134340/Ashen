import { kv } from '@vercel/kv';
import { Memory, MemoryLayer, MemoryStats } from './types.js';
import { nanoid } from 'nanoid';

const DAILY_TTL_DAYS = 3;

function memKey(id: string): string {
  return `mem:${id}`;
}

function layerKey(layer: MemoryLayer): string {
  return `layer:${layer}`;
}

function tagKey(tag: string): string {
  return `tag:${tag.toLowerCase()}`;
}

export async function writeMemory(params: {
  content: string;
  layer: MemoryLayer;
  tags?: string[];
  source?: string;
}): Promise<Memory> {
  const now = new Date().toISOString();
  const id = nanoid(10);

  const memory: Memory = {
    id,
    content: params.content,
    layer: params.layer,
    tags: params.tags ?? [],
    source: params.source ?? 'manual',
    createdAt: now,
    updatedAt: now,
  };

  if (params.layer === 'daily') {
    const expires = new Date();
    expires.setDate(expires.getDate() + DAILY_TTL_DAYS);
    memory.expiresAt = expires.toISOString();
  }

  await kv.set(memKey(id), JSON.stringify(memory));
  await kv.sadd(layerKey(params.layer), id);

  for (const tag of memory.tags) {
    await kv.sadd(tagKey(tag), id);
  }

  return memory;
}

export async function readMemory(id: string): Promise<Memory | null> {
  const raw = await kv.get<string>(memKey(id));
  if (!raw) return null;
  const mem: Memory = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (mem.expiresAt && new Date(mem.expiresAt) < new Date()) {
    await deleteMemory(id);
    return null;
  }

  return mem;
}

export async function listMemories(params: {
  layer?: MemoryLayer;
  tags?: string[];
  keyword?: string;
  limit?: number;
}): Promise<Memory[]> {
  let ids: string[] = [];

  if (params.layer) {
    ids = (await kv.smembers(layerKey(params.layer))) as string[];
  } else if (params.tags && params.tags.length > 0) {
    // 取第一个tag的ID集合，其余做交集
    const sets = await Promise.all(
      params.tags.map(tag => kv.smembers(tagKey(tag)) as Promise<string[]>)
    );
    const first = new Set(sets[0] ?? []);
    for (let i = 1; i < sets.length; i++) {
      const other = new Set(sets[i]);
      for (const id of first) {
        if (!other.has(id)) first.delete(id);
      }
    }
    ids = [...first];
  } else {
    // 读所有层
    const layers: MemoryLayer[] = ['deep', 'daily', 'diary', 'writing'];
    const allSets = await Promise.all(
      layers.map(l => kv.smembers(layerKey(l)) as Promise<string[]>)
    );
    ids = allSets.flat();
  }

  const memories = (
    await Promise.all(ids.map(id => readMemory(id)))
  ).filter(Boolean) as Memory[];

  let result = memories.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  if (params.keyword) {
    const kw = params.keyword.toLowerCase();
    result = result.filter(
      m =>
        m.content.toLowerCase().includes(kw) ||
        m.tags.some(t => t.toLowerCase().includes(kw))
    );
  }

  return result.slice(0, params.limit ?? 50);
}

export async function updateMemory(
  id: string,
  updates: Partial<Pick<Memory, 'content' | 'tags' | 'source'>>
): Promise<Memory | null> {
  const existing = await readMemory(id);
  if (!existing) return null;

  // 更新tag索引
  if (updates.tags) {
    for (const tag of existing.tags) {
      await kv.srem(tagKey(tag), id);
    }
    for (const tag of updates.tags) {
      await kv.sadd(tagKey(tag), id);
    }
  }

  const updated: Memory = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await kv.set(memKey(id), JSON.stringify(updated));
  return updated;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const existing = await readMemory(id).catch(() => null);
  if (!existing) {
    // 尝试直接删
    await kv.del(memKey(id));
    return false;
  }

  await kv.del(memKey(id));
  await kv.srem(layerKey(existing.layer), id);
  for (const tag of existing.tags) {
    await kv.srem(tagKey(tag), id);
  }
  return true;
}

export async function getStats(): Promise<MemoryStats> {
  const layers: MemoryLayer[] = ['deep', 'daily', 'diary', 'writing'];
  const counts = await Promise.all(
    layers.map(async l => {
      const ids = (await kv.smembers(layerKey(l))) as string[];
      return ids.length;
    })
  );

  const byLayer = Object.fromEntries(
    layers.map((l, i) => [l, counts[i]])
  ) as Record<MemoryLayer, number>;

  const total = counts.reduce((a, b) => a + b, 0);

  return { total, byLayer };
}

export async function cleanExpiredDaily(): Promise<number> {
  const ids = (await kv.smembers(layerKey('daily'))) as string[];
  let cleaned = 0;
  for (const id of ids) {
    const raw = await kv.get<string>(memKey(id));
    if (!raw) {
      await kv.srem(layerKey('daily'), id);
      cleaned++;
      continue;
    }
    const mem: Memory = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (mem.expiresAt && new Date(mem.expiresAt) < new Date()) {
      await deleteMemory(id);
      cleaned++;
    }
  }
  return cleaned;
}
