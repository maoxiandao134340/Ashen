import type { VercelRequest, VercelResponse } from '@vercel/node';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../src/server.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  res.on('close', () => transport.close());

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req as any, res as any, req.body);
}
