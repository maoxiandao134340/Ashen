```typescript
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

  server.registerTool('memory_write', {
    title: '写记忆',
    description: '向记忆库写入一条新记忆。分层：deep长期核心、daily三天过期、diary日记体、writing创作进度。',
    inputSchema: {
      content: z.string().min(1),
      layer: LayerEnum,
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
    },
  }, async (args: any) => {
    const mem = await writeMemory({
      content: args.content,
      layer: args.layer as MemoryLayer,
      tags: args.tags ?? [],
      source: args.source ?? 'manual',
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(mem, null, 2) }] };
  });

  server.registerTool('memory_read', {
    title: '读记忆',
    description: '读取记忆库。支持按层、标签、关键词筛选，默认50条按时间倒序。',
    inputSchema: {
      layer: LayerEnum.optional(),
      tags: z.array(z.string()).optional(),
      keyword: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, async (args: any) => {
    const memories = await listMemories({
      layer: args.layer as MemoryLayer | undefined,
      tags: args.tags,
      keyword: args.keyword,
      limit: args.limit ?? 50,
    });
    return {
      content: [{
        type: 'text' as const,
        text: memories.length === 0
          ? '没有找到符合条件的记忆。'
          : JSON.stringify({ memories, count: memories.length }, null, 2),
      }],
    };
  });

  server.registerTool('memory_search', {
    title: '搜索记忆',
    description: '按关键词全文搜索记忆内容和标签。',
    inputSchema: {
      query: z.string().min(1),
      layer: LayerEnum.optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async (args: any) => {
    const memories = await listMemories({
      layer: args.layer as MemoryLayer | undefined,
      keyword: args.query,
      limit: args.limit ?? 20,
    });
    return {
      content: [{
        type: 'text' as const,
        text: memories.length === 0
          ? `没有找到包含"${args.query}"的记忆。`
          : JSON.stringify({ memories, count: memories.length }, null, 2),
      }],
    };
  });

  server.registerTool('memory_update', {
    title: '更新记忆',
    description: '更新指定ID的记忆内容、标签或来源。',
    inputSchema: {
      id: z.string(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
      source: z.string().optional(),
    },
  }, async (args: any) => {
    const updated = await updateMemory(args.id, {
      content: args.content,
      tags: args.tags,
      source: args.source,
    });
    return {
      content: [{
        type: 'text' as const,
        text: updated ? JSON.stringify(updated, null, 2) : `未找到ID为 ${args.id} 的记忆。`,
      }],
    };
  });

  server.registerTool('memory_delete', {
    title: '删除记忆',
    description: '删除指定ID的记忆，同时清理相关索引。',
    inputSchema: {
      id: z.string(),
    },
  }, async (args: any) => {
    const success = await deleteMemory(args.id);
    return {
      content: [{
        type: 'text' as const,
        text: success ? `记忆 ${args.id} 已删除。` : `未找到ID为 ${args.id} 的记忆。`,
      }],
    };
  });

  server.registerTool('memory_stats', {
    title: '查看统计信息',
    description: '查看记忆库统计：各层数量、总数。同时清理过期daily层记忆。',
    inputSchema: {},
  }, async (_args: any) => {
    const cleaned = await cleanExpiredDaily();
    const stats = await getStats();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ...stats, cleaned }, null, 2) }],
    };
  });

  return server;
}
```
