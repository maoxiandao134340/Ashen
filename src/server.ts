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
    title: 'write memory',
    description: 'Write a new memory. Layers: deep=core long-term, daily=expires in 3 days, diary=journal, writing=creative progress.',
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
    title: 'read memories',
    description: 'Read memories. Filter by layer, tags, or keyword. Default limit 50, newest first.',
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
          ? 'No memories found.'
          : JSON.stringify({ memories, count: memories.length }, null, 2),
      }],
    };
  });

  server.registerTool('memory_search', {
    title: 'search memories',
    description: 'Full-text search across memory content and tags.',
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
          ? 'No memories found for: ' + args.query
          : JSON.stringify({ memories, count: memories.length }, null, 2),
      }],
    };
  });

  server.registerTool('memory_update', {
    title: 'update memory',
    description: 'Update content, tags, or source of a memory by ID.',
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
        text: updated ? JSON.stringify(updated, null, 2) : 'Memory not found: ' + args.id,
      }],
    };
  });

  server.registerTool('memory_delete', {
    title: 'delete memory',
    description: 'Delete a memory by ID and clean up all related indexes.',
    inputSchema: {
      id: z.string(),
    },
  }, async (args: any) => {
    const success = await deleteMemory(args.id);
    return {
      content: [{
        type: 'text' as const,
        text: success ? 'Deleted: ' + args.id : 'Memory not found: ' + args.id,
      }],
    };
  });

  server.registerTool('memory_stats', {
    title: 'memory stats',
    description: 'View memory counts by layer. Also cleans expired daily memories.',
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
