import type { VercelRequest, VercelResponse } from '@vercel/node';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Redis } from '@upstash/redis';
import { nanoid } from 'nanoid';

// ── Types ─────────────────────────────────────────────────────────────────────

type MemoryLayer = 'deep' | 'daily' | 'diary' | 'writing';

interface Memory {
  id: string;
  content: string;
  layer: MemoryLayer;
  tags: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

// ── Storage ───────────────────────────────────────────────────────────────────

function getRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

function memKey(id: string) { return `mem:${id}`; }
function layerKey(layer: MemoryLayer) { return `layer:${layer}`; }
function tagKey(tag: string) { return `tag:${tag.toLowerCase()}`; }

async function writeMemory(params: { content: string; layer: MemoryLayer; tags: string[]; source: string }): Promise<Memory> {
  const redis = getRedis();
  const now = new Date().toISOString();
  const id = nanoid(10);
  const memory: Memory = { id, content: params.content, layer: params.layer, tags: params.tags, source: params.source, createdAt: now, updatedAt: now };
  if (params.layer === 'daily') {
    const exp = new Date(); exp.setDate(exp.getDate() + 3);
    memory.expiresAt = exp.toISOString();
  }
  await redis.set(memKey(id), JSON.stringify(memory));
  await redis.sadd(layerKey(params.layer), id);
  for (const tag of memory.tags) await redis.sadd(tagKey(tag), id);
  return memory;
}

async function readMemoryById(redis: Redis, id: string): Promise<Memory | null> {
  const raw = await redis.get<string>(memKey(id));
  if (!raw) return null;
  const mem: Memory = typeof raw === 'string' ? JSON.parse(raw) : raw as Memory;
  if (mem.expiresAt && new Date(mem.expiresAt) < new Date()) {
    await deleteMemoryById(redis, mem);
    return null;
  }
  return mem;
}

async function deleteMemoryById(redis: Redis, mem: Memory): Promise<void> {
  await redis.del(memKey(mem.id));
  await redis.srem(layerKey(mem.layer), mem.id);
  for (const tag of mem.tags) await redis.srem(tagKey(tag), mem.id);
}

async function listMemories(params: { layer?: MemoryLayer; tags?: string[]; keyword?: string; limit: number }): Promise<Memory[]> {
  const redis = getRedis();
  let ids: string[] = [];
  if (params.layer) {
    ids = (await redis.smembers(layerKey(params.layer))) as string[];
  } else {
    const layers: MemoryLayer[] = ['deep', 'daily', 'diary', 'writing'];
    const sets = await Promise.all(layers.map(l => redis.smembers(layerKey(l)) as Promise<string[]>));
    ids = sets.flat();
  }
  const memories = (await Promise.all(ids.map(id => readMemoryById(redis, id)))).filter(Boolean) as Memory[];
  let result = memories.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (params.keyword) {
    const kw = params.keyword.toLowerCase();
    result = result.filter(m => m.content.toLowerCase().includes(kw) || m.tags.some(t => t.toLowerCase().includes(kw)));
  }
  return result.slice(0, params.limit);
}

async function updateMemory(id: string, updates: Partial<Pick<Memory, 'content' | 'tags' | 'source'>>): Promise<Memory | null> {
  const redis = getRedis();
  const existing = await readMemoryById(redis, id);
  if (!existing) return null;
  if (updates.tags) {
    for (const tag of existing.tags) await redis.srem(tagKey(tag), id);
    for (const tag of updates.tags) await redis.sadd(tagKey(tag), id);
  }
  const updated: Memory = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await redis.set(memKey(id), JSON.stringify(updated));
  return updated;
}

async function deleteMemory(id: string): Promise<boolean> {
  const redis = getRedis();
  const existing = await readMemoryById(redis, id);
  if (!existing) return false;
  await deleteMemoryById(redis, existing);
  return true;
}

async function getStats(): Promise<{ total: number; byLayer: Record<MemoryLayer, number> }> {
  const redis = getRedis();
  const layers: MemoryLayer[] = ['deep', 'daily', 'diary', 'writing'];
  const counts = await Promise.all(layers.map(async l => (await redis.smembers(layerKey(l)) as string[]).length));
  const byLayer = Object.fromEntries(layers.map((l, i) => [l, counts[i]])) as Record<MemoryLayer, number>;
  return { total: counts.reduce((a, b) => a + b, 0), byLayer };
}

async function cleanExpiredDaily(): Promise<number> {
  const redis = getRedis();
  const ids = (await redis.smembers(layerKey('daily'))) as string[];
  let cleaned = 0;
  for (const id of ids) {
    const raw = await redis.get<string>(memKey(id));
    if (!raw) { await redis.srem(layerKey('daily'), id); cleaned++; continue; }
    const mem: Memory = typeof raw === 'string' ? JSON.parse(raw) : raw as Memory;
    if (mem.expiresAt && new Date(mem.expiresAt) < new Date()) {
      await deleteMemoryById(redis, mem); cleaned++;
    }
  }
  return cleaned;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: 'ashen-memory-mcp-server', version: '1.0.0' });

  server.registerTool('memory_write', {
    title: 'write memory',
    description: 'Write a new memory. Layers: deep=core long-term, daily=expires in 3 days, diary=journal, writing=creative progress.',
    inputSchema: { type: 'object' as const, properties: { content: { type: 'string' }, layer: { type: 'string', enum: ['deep','daily','diary','writing'] }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string' } }, required: ['content', 'layer'] },
  }, async (args: any) => {
    const mem = await writeMemory({ content: args.content, layer: args.layer, tags: args.tags ?? [], source: args.source ?? 'manual' });
    return { content: [{ type: 'text' as const, text: JSON.stringify(mem, null, 2) }] };
  });

  server.registerTool('memory_read', {
    title: 'read memories',
    description: 'Read memories. Filter by layer, tags, or keyword.',
    inputSchema: { type: 'object' as const, properties: { layer: { type: 'string', enum: ['deep','daily','diary','writing'] }, tags: { type: 'array', items: { type: 'string' } }, keyword: { type: 'string' }, limit: { type: 'number' } } },
  }, async (args: any) => {
    const memories = await listMemories({ layer: args.layer, tags: args.tags, keyword: args.keyword, limit: args.limit ?? 50 });
    return { content: [{ type: 'text' as const, text: memories.length === 0 ? 'No memories found.' : JSON.stringify({ memories, count: memories.length }, null, 2) }] };
  });

  server.registerTool('memory_search', {
    title: 'search memories',
    description: 'Full-text search across memory content and tags.',
    inputSchema: { type: 'object' as const, properties: { query: { type: 'string' }, layer: { type: 'string', enum: ['deep','daily','diary','writing'] }, limit: { type: 'number' } }, required: ['query'] },
  }, async (args: any) => {
    const memories = await listMemories({ layer: args.layer, keyword: args.query, limit: args.limit ?? 20 });
    return { content: [{ type: 'text' as const, text: memories.length === 0 ? 'No memories found for: ' + args.query : JSON.stringify({ memories, count: memories.length }, null, 2) }] };
  });

  server.registerTool('memory_update', {
    title: 'update memory',
    description: 'Update content, tags, or source of a memory by ID.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string' } }, required: ['id'] },
  }, async (args: any) => {
    const updated = await updateMemory(args.id, { content: args.content, tags: args.tags, source: args.source });
    return { content: [{ type: 'text' as const, text: updated ? JSON.stringify(updated, null, 2) : 'Memory not found: ' + args.id }] };
  });

  server.registerTool('memory_delete', {
    title: 'delete memory',
    description: 'Delete a memory by ID.',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
  }, async (args: any) => {
    const success = await deleteMemory(args.id);
    return { content: [{ type: 'text' as const, text: success ? 'Deleted: ' + args.id : 'Memory not found: ' + args.id }] };
  });

  server.registerTool('memory_stats', {
    title: 'memory stats',
    description: 'View memory counts by layer. Also cleans expired daily memories.',
    inputSchema: { type: 'object' as const, properties: {} },
  }, async (_args: any) => {
    const cleaned = await cleanExpiredDaily();
    const stats = await getStats();
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ...stats, cleaned }, null, 2) }] };
  });

  return server;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method === 'GET') { res.status(200).json({ ok: true, name: 'ashen-memory-mcp-server' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
