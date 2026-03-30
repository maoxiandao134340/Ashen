import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  writeMemory,
  listMemories,
  updateMemory,
  deleteMemory,
  getStats,
  cleanExpiredDaily,
} from './storage.js';
import { MemoryLayer } from './types.js';

const LayerEnum = z.enum(['deep', 'daily', 'diary', 'writing']);

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ashen-memory-mcp-server',
    version: '1.0.0',
  });

  server.registerTool(
    'memory_write',
    {
      title: '写记忆',
      description: '向记忆库写入一条新记忆。分层：deep长期核心、daily三天过期、diary日记体、writing创作进度。',
      inputSchema: {
        content: z.string().min(1).describe('记忆内容'),
        layer: LayerEnum.describe('记忆层级'),
        tags: z.array(z.string()).optional().describe('标签列表'),
        source: z.string().optional().describe('来源'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ content, layer, tags, source }) => {
      const mem = await writeMemory({
        content,
        layer: layer as MemoryLayer,
        tags: tags ?? [],
        source: source ?? 'manual',
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(mem, null, 2) }] };
    }
  );

  server.registerTool(
    'memory_read',
    {
      title: '读记忆',
      description: '读取记忆库。支持按层、标签、关键词筛选，默认返回50条按时间倒序。',
      inputSchema: {
        layer: LayerEnum.optional().describe('按层筛选'),
        tags: z.array(z.string()).optional().describe('按标签筛选'),
        keyword: z.string().optional().describe('关键词搜索'),
        limit: z.number().int().min(1).max(200).optional().describe('最多返回条数'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ layer, tags, keyword, limit }) => {
      const memories = await listMemories({
        layer: layer as MemoryLayer | undefined,
        tags,
        keyword,
        limit: limit ?? 50,
      });
      return {
        content: [{
          type: 'text' as const,
          text: memories.length === 0
            ? '没有找到符合条件的记忆。'
            : JSON.stringify({ memories, count: memories.length }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    'memory_search',
    {
      title: '搜索记忆',
      description: '按关键词全文搜索记忆内容和标签。',
      inputSchema: {
        query: z.string().min(1).describe('搜索词'),
        layer: LayerEnum.optional().describe('限定搜索层级'),
        limit: z.number().int().min(1).max(100).optional().describe('最多返回条数'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, layer, limit }) => {
      const memories = await listMemories({
        layer: layer as MemoryLayer | undefined,
        keyword: query,
        limit: limit ?? 20,
      });
      return {
        content: [{
          type: 'text' as const,
          text: memories.length === 0
            ? `没有找到包含"${query}"的记忆。`
            : JSON.stringify({ memories, query, count: memories.length }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    'memory_update',
    {
      title: '更新记忆',
      description: '更新指定ID的记忆内容、标签或来源。',
      inputSchema: {
        id: z.string().describe('记忆ID'),
        content: z.string().optional().describe('新内容'),
        tags: z.array(z.string()).optional().describe('新标签'),
        source: z.string().optional().describe('新来源'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, content, tags, source }) => {
      const updated = await updateMemory(id, { content, tags, source });
      return {
        content: [{
          type: 'text' as const,
          text: updated
            ? JSON.stringify(updated, null, 2)
            : `未找到ID为 ${id} 的记忆。`,
        }],
      };
    }
  );

  server.registerTool(
    'memory_delete',
    {
      title: '删除记忆',
      description: '删除指定ID的记忆，同时清理相关索引。',
      inputSchema: {
        id: z.string().describe('要删除的记忆ID'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const success = await deleteMemory(id);
      return {
        content: [{
          type: 'text' as const,
          text: success ? `记忆 ${id} 已删除。` : `未找到ID为 ${id} 的记忆。`,
        }],
      };
    }
  );

  server.registerTool(
    'memory_stats',
    {
      title: '查看统计信息',
      description: '查看记忆库统计：各层数量、总数。同时触发清理过期daily层记忆。',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const cleaned = await cleanExpiredDaily();
      const stats = await getStats();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...stats, cleaned }, null, 2) }],
      };
    }
  );

  return server;
}
