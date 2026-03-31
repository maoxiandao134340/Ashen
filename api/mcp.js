const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { Redis } = require('@upstash/redis');
const { nanoid } = require('nanoid');

function getRedis() {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
}

const memKey = id => `mem:${id}`;
const layerKey = layer => `layer:${layer}`;
const tagKey = tag => `tag:${tag.toLowerCase()}`;

async function writeMemory({ content, layer, tags, source }) {
  const redis = getRedis();
  const now = new Date().toISOString();
  const id = nanoid(10);
  const memory = { id, content, layer, tags, source, createdAt: now, updatedAt: now };
  if (layer === 'daily') {
    const exp = new Date(); exp.setDate(exp.getDate() + 3);
    memory.expiresAt = exp.toISOString();
  }
  await redis.set(memKey(id), JSON.stringify(memory));
  await redis.sadd(layerKey(layer), id);
  for (const tag of tags) await redis.sadd(tagKey(tag), id);
  return memory;
}

async function readMemoryById(redis, id) {
  const raw = await redis.get(memKey(id));
  if (!raw) return null;
  const mem = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (mem.expiresAt && new Date(mem.expiresAt) < new Date()) {
    await deleteMemoryObj(redis, mem);
    return null;
  }
  return mem;
}

async function deleteMemoryObj(redis, mem) {
  await redis.del(memKey(mem.id));
  await redis.srem(layerKey(mem.layer), mem.id);
  for (const tag of mem.tags) await redis.srem(tagKey(tag), mem.id);
}

async function listMemories({ layer, tags, keyword, limit }) {
  const redis = getRedis();
  let ids = [];
  if (layer) {
    ids = await redis.smembers(layerKey(layer));
  } else {
    const sets = await Promise.all(['deep','daily','diary','writing'].map(l => redis.smembers(layerKey(l))));
    ids = sets.flat();
  }
  const memories = (await Promise.all(ids.map(id => readMemoryById(redis, id)))).filter(Boolean);
  let result = memories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (keyword) {
    const kw = keyword.toLowerCase();
    result = result.filter(m => m.content.toLowerCase().includes(kw) || m.tags.some(t => t.toLowerCase().includes(kw)));
  }
  return result.slice(0, limit || 50);
}

async function updateMemory(id, updates) {
  const redis = getRedis();
  const existing = await readMemoryById(redis, id);
  if (!existing) return null;
  if (updates.tags) {
    for (const tag of existing.tags) await redis.srem(tagKey(tag), id);
    for (const tag of updates.tags) await redis.sadd(tagKey(tag), id);
  }
  const updated = { ...existing, ...updates, updatedAt: new Date().toISOString() };
  await redis.set(memKey(id), JSON.stringify(updated));
  return updated;
}

async function deleteMemory(id) {
  const redis = getRedis();
  const existing = await readMemoryById(redis, id);
  if (!existing) return false;
  await deleteMemoryObj(redis, existing);
  return true;
}

async function getStats() {
  const redis = getRedis();
  const layers = ['deep','daily','diary','writing'];
  const counts = await Promise.all(layers.map(async l => (await redis.smembers(layerKey(l))).length));
  const byLayer = Object.fromEntries(layers.map((l, i) => [l, counts[i]]));
  return { total: counts.reduce((a, b) => a + b, 0), byLayer };
}

async function cleanExpiredDaily() {
  const redis = getRedis();
  const ids = await redis.smembers(layerKey('daily'));
  let cleaned = 0;
  for (const id of ids) {
    const raw = await redis.get(memKey(id));
    if (!raw) { await redis.srem(layerKey('daily'), id); cleaned++; continue; }
    const mem = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (mem.expiresAt && new Date(mem.expiresAt) < new Date()) {
      await deleteMemoryObj(redis, mem); cleaned++;
    }
  }
  return cleaned;
}

function createServer() {
  const server = new McpServer({ name: 'ashen-memory-mcp-server', version: '1.0.0' });

  server.registerTool('memory_write', {
    title: 'write memory',
    description: 'Write a new memory. Layers: deep=core long-term, daily=expires in 3 days, diary=journal, writing=creative progress.',
    inputSchema: { type: 'object', properties: { content: { type: 'string' }, layer: { type: 'string', enum: ['deep','daily','diary','writing'] }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string' } }, required: ['content', 'layer'] },
  }, async (args) => {
    const mem = await writeMemory({ content: args.content, layer: args.layer, tags: args.tags || [], source: args.source || 'manual' });
    return { content: [{ type: 'text', text: JSON.stringify(mem, null, 2) }] };
  });

  server.registerTool('memory_read', {
    title: 'read memories',
    description: 'Read memories. Filter by layer, tags, or keyword.',
    inputSchema: { type: 'object', properties: { layer: { type: 'string', enum: ['deep','daily','diary','writing'] }, tags: { type: 'array', items: { type: 'string' } }, keyword: { type: 'string' }, limit: { type: 'number' } } },
  }, async (args) => {
    const memories = await listMemories({ layer: args.layer, tags: args.tags, keyword: args.keyword, limit: args.limit || 50 });
    return { content: [{ type: 'text', text: memories.length === 0 ? 'No memories found.' : JSON.stringify({ memories, count: memories.length }, null, 2) }] };
  });

  server.registerTool('memory_search', {
    title: 'search memories',
    description: 'Full-text search across memory content and tags.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, layer: { type: 'string', enum: ['deep','daily','diary','writing'] }, limit: { type: 'number' } }, required: ['query'] },
  }, async (args) => {
    const memories = await listMemories({ layer: args.layer, keyword: args.query, limit: args.limit || 20 });
    return { content: [{ type: 'text', text: memories.length === 0 ? 'No memories found for: ' + args.query : JSON.stringify({ memories, count: memories.length }, null, 2) }] };
  });

  server.registerTool('memory_update', {
    title: 'update memory',
    description: 'Update content, tags, or source of a memory by ID.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, source: { type: 'string' } }, required: ['id'] },
  }, async (args) => {
    const updated = await updateMemory(args.id, { content: args.content, tags: args.tags, source: args.source });
    return { content: [{ type: 'text', text: updated ? JSON.stringify(updated, null, 2) : 'Memory not found: ' + args.id }] };
  });

  server.registerTool('memory_delete', {
    title: 'delete memory',
    description: 'Delete a memory by ID.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  }, async (args) => {
    const success = await deleteMemory(args.id);
    return { content: [{ type: 'text', text: success ? 'Deleted: ' + args.id : 'Memory not found: ' + args.id }] };
  });

  server.registerTool('memory_stats', {
    title: 'memory stats',
    description: 'View memory counts by layer. Also cleans expired daily memories.',
    inputSchema: { type: 'object', properties: {} },
  }, async (_args) => {
    const cleaned = await cleanExpiredDaily();
    const stats = await getStats();
    return { content: [{ type: 'text', text: JSON.stringify({ ...stats, cleaned }, null, 2) }] };
  });

  return server;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method === 'GET') { res.status(200).json({ ok: true, name: 'ashen-memory-mcp-server' }); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => transport.close());
    const server = createServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};
