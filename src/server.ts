import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  writeMemory,
  readMemory,
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

  // ── 1. 写记忆 ────────────────────────────────────────────────────────────
  server.registerTool(
    'memory_write',
    {
      title: '写记忆',
      description: `向记忆库写入一条新记忆。

分层说明：
- deep: 长期不变的核心信息（身份设定、规则、稳定偏好）
- daily: 最近几天的事，3天后自动清除
- diary: 带感情色彩的日记体记录
- writing: 创作进度与故事状态

Args:
  - content (string): 记忆内容
  - layer ('deep'|'daily'|'diary'|'writing'): 所属层
  - tags (string[]): 标签，用于检索
  - source (string): 来源描述（如 '对话总结'、'收工流程'）

Returns: 完整的记忆对象（含自动生成的ID和时间戳）`,
      inputSchema: z.object({
        content: z.string().min(1).describe('记忆内容'),
        layer: LayerEnum.describe('记忆层级'),
        tags: z.array(z.string()).optional().default([]).describe('标签列表'),
        source: z.string().optional().default('manual').describe('来源'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ content, layer, tags, source }) => {
      const mem = await writeMemory({
        content,
        layer: layer as MemoryLayer,
        tags,
        source,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(mem, null, 2) }],
        structuredContent: mem,
      };
    }
  );

  // ── 2. 读记忆 ────────────────────────────────────────────────────────────
  server.registerTool(
    'memory_read',
    {
      title: '读记忆',
      description: `读取记忆库。支持按层、标签、关键词筛选。

Args:
  - layer?: 只读取指定层
  - tags?: 按标签筛选（多标签取交集）
  - keyword?: 关键词全文搜索（内容+标签）
  - limit?: 最多返回条数，默认50

Returns: 记忆数组，按创建时间倒序`,
      inputSchema: z.object({
        layer: LayerEnum.optional().describe('按层筛选'),
        tags: z.array(z.string()).optional().describe('按标签筛选'),
        keyword: z.string().optional().describe('关键词搜索'),
        limit: z.number().int().min(1).max(200).optional().default(50).describe('最多返回条数'),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ layer, tags, keyword, limit }) => {
      const memories = await listMemories({
        layer: layer as MemoryLayer | undefined,
        tags,
        keyword,
        limit,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              memories.length === 0
                ? '没有找到符合条件的记忆。'
                : JSON.stringify(memories, null, 2),
          },
        ],
        structuredContent: { memories, count: memories.length },
      };
    }
  );

  // ── 3. 搜索记忆 ──────────────────────────────────────────────────────────
  server.registerTool(
    'memory_search',
    {
      title: '搜索记忆',
      description: `按关键词全文搜索记忆内容和标签。

Args:
  - query (string): 搜索词
  - layer?: 限定在某一层搜索
  - limit?: 最多返回条数，默认20

Returns: 匹配的记忆数组`,
      inputSchema: z.object({
        query: z.string().min(1).describe('搜索词'),
        layer: LayerEnum.optional().describe('限定搜索层级'),
        limit: z.number().int().min(1).max(100).optional().default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, layer, limit }) => {
      const memories = await listMemories({
        layer: layer as MemoryLayer | undefined,
        keyword: query,
        limit,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              memories.length === 0
                ? `没有找到包含"${query}"的记忆。`
                : JSON.stringify(memories, null, 2),
          },
        ],
        structuredContent: { memories, query, count: memories.length },
      };
    }
  );

  // ── 4. 更新记忆 ──────────────────────────────────────────────────────────
  server.registerTool(
    'memory_update',
    {
      title: '更新记忆',
      description: `更新指定ID的记忆内容、标签或来源。

Args:
  - id (string): 记忆ID
  - content?: 新内容
  - tags?: 新标签列表（完全替换）
  - source?: 新来源

Returns: 更新后的记忆对象，或 null（ID不存在时）`,
      inputSchema: z.object({
        id: z.string().describe('记忆ID'),
        content: z.string().optional().describe('新内容'),
        tags: z.array(z.string()).optional().describe('新标签'),
        source: z.string().optional().describe('新来源'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, content, tags, source }) => {
      const updated = await updateMemory(id, { content, tags, source });
      if (!updated) {
        return {
          content: [{ type: 'text', text: `未找到ID为 ${id} 的记忆。` }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
        structuredContent: updated,
      };
    }
  );

  // ── 5. 删除记忆 ──────────────────────────────────────────────────────────
  server.registerTool(
    'memory_delete',
    {
      title: '删除记忆',
      description: `删除指定ID的记忆。同时清理所有相关索引。

Args:
  - id (string): 要删除的记忆ID

Returns: 是否成功删除`,
      inputSchema: z.object({
        id: z.string().describe('要删除的记忆ID'),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const success = await deleteMemory(id);
      return {
        content: [
          {
            type: 'text',
            text: success ? `记忆 ${id} 已删除。` : `未找到ID为 ${id} 的记忆。`,
          },
        ],
        structuredContent: { id, deleted: success },
      };
    }
  );

  // ── 6. 统计信息 ──────────────────────────────────────────────────────────
  server.registerTool(
    'memory_stats',
    {
      title: '查看统计信息',
      description: `查看记忆库的统计信息：各层记忆数量、总数等。
同时触发清理过期的 daily 层记忆。

Returns: 统计对象，含 total、byLayer（各层数量）、cleaned（本次清理数量）`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const cleaned = await cleanExpiredDaily();
      const stats = await getStats();
      const result = { ...stats, cleaned };
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  return server;
}
