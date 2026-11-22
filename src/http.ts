import crypto from 'node:crypto';
import http from 'node:http';
import { hostHeaderValidation, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import type { Ops } from './ops.js';
import type { StatusChecker } from './status.js';
import { registerTools } from './tools.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Constant-time check of the bearer token. Hashing first makes the comparison independent of length. */
export function checkBearer(header: string | undefined, token: string): boolean {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? '');
  const given = crypto.createHash('sha256').update(m ? m[1]! : '').digest();
  const want = crypto.createHash('sha256').update(token).digest();
  return crypto.timingSafeEqual(given, want) && m !== null;
}

function sendJson(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

export function createHttpServer(cfg: Config, ops: Ops, status: StatusChecker): http.Server {
  const validateHost = hostHeaderValidation(cfg.allowedHosts);

  return http.createServer(async (req, res) => {
    try {
      if (!validateHost(req, res)) return;
      if (!checkBearer(req.headers.authorization, cfg.token)) {
        return sendJson(res, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/mcp') return sendJson(res, 404, 'Not found');
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > MAX_BODY_BYTES) return sendJson(res, 413, 'Request body too large');

      // Stateless: a fresh server and transport per request. Only this mode's tools are registered.
      const server = new McpServer({ name: 'obsidian-vault-mcp', version: '0.1.0' });
      registerTools(server, ops, status, cfg.accessMode);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error('request failed:', e);
      if (!res.headersSent) sendJson(res, 500, 'Internal server error');
    }
  });
}
