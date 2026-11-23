import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { checkBearer } from '../src/http.js';
import { buildApp } from '../src/index.js';
import { runTool, toolDefs } from '../src/tools.js';
import { activeExec, makeOps, makeVault, testConfig, TOKEN, type TestVault } from './helpers.js';

const READ_TOOLS = [
  'get_backlinks',
  'get_daily_note',
  'get_outgoing_links',
  'find_orphans',
  'list_notes',
  'list_property_keys',
  'list_property_values',
  'list_tags',
  'read_daily_notes',
  'read_image',
  'read_note',
  'recent_notes',
  'search_by_property',
  'search_by_tag',
  'search_notes',
  'stale_notes',
  'vault_status',
].sort();
const WRITE_TOOLS = ['append_to_note', 'create_note', 'replace_in_note', 'update_properties'];
const FULL_TOOLS = ['delete_note', 'move_folder', 'move_note', 'rename_note'];

let tv: TestVault;
let close: (() => Promise<void>) | null = null;
beforeEach(() => {
  tv = makeVault();
});
afterEach(async () => {
  await close?.();
  close = null;
  fs.rmSync(tv.base, { recursive: true, force: true });
});

async function start(env: Record<string, string> = {}) {
  const cfg = testConfig(tv.dir, { PORT: '1', ...env });
  const { server } = buildApp(cfg, activeExec);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  close = () => new Promise((r) => server.close(() => r()));
  return `http://127.0.0.1:${port}/mcp`;
}

async function connect(url: string, token = TOKEN) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
});
const post = (url: string, headers: Record<string, string>) =>
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: initBody });

describe('auth and transport', () => {
  it('rejects missing, wrong and malformed tokens with 401', async () => {
    const url = await start();
    expect((await post(url, {})).status).toBe(401);
    expect((await post(url, { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await post(url, { Authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await post(url, { Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await fetch(url, { method: 'GET' })).status).toBe(401);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(401);
  });

  it('rejects unknown Host headers with 403', async () => {
    const url = await start();
    // fetch won't let us set Host, so call the checker the server uses through a raw request.
    const http = await import('node:http');
    const u = new URL(url);
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end(initBody);
    });
    expect(status).toBe(403);
  });

  it('accepts a configured public host name', async () => {
    const url = await start({ ALLOWED_HOSTS: 'localhost,127.0.0.1,vault.example.test' });
    const http = await import('node:http');
    const u = new URL(url);
    const status = await new Promise<number>((resolve) => {
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: { Host: 'vault.example.test', Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.end(initBody);
    });
    expect(status).toBe(200);
  });

  it('checkBearer is exact', () => {
    expect(checkBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkBearer(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkBearer(undefined, TOKEN)).toBe(false);
    expect(checkBearer('Bearer ', TOKEN)).toBe(false);
    expect(checkBearer(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
  });
});

describe('access modes', () => {
  it('read mode lists only read tools and refuses write calls', async () => {
    const client = await connect(await start({ ACCESS_MODE: 'read' }));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(READ_TOOLS);
    const daily = (await client.listTools()).tools.find((t) => t.name === 'get_daily_note')!;
    expect(Object.keys((daily.inputSchema as { properties?: object }).properties ?? {})).toEqual(['date']);

    let refused = false;
    try {
      const r = await client.callTool({ name: 'create_note', arguments: { path: 'Hack.md', content: 'x' } });
      refused = r.isError === true;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
    expect(fs.existsSync(path.join(tv.dir, 'Hack.md'))).toBe(false);
    await client.close();
  });

  it('write mode adds the write tools', async () => {
    const client = await connect(await start({ ACCESS_MODE: 'write' }));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
    const r = await client.callTool({ name: 'create_note', arguments: { title: 'From Client', content: 'hello\n' } });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(tv.dir, 'Seedlings', 'From Client.md'), 'utf8')).toBe('hello\n');
    await client.close();
  });

  it('read and write mode have no delete, move or rename tools', async () => {
    for (const mode of ['read', 'write']) {
      const client = await connect(await start({ ACCESS_MODE: mode }));
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names.filter((n) => /delete|move|rename/.test(n)), mode).toEqual([]);
      const r = await client.callTool({ name: 'delete_note', arguments: { path: 'Lonely.md' } }).catch(() => ({ isError: true }));
      expect(r.isError, mode).toBe(true);
      expect(fs.existsSync(path.join(tv.dir, 'Lonely.md'))).toBe(true);
      await client.close();
      await close?.();
      close = null;
    }
  });

  it('full mode adds the full tools on top of the write tools, marked destructive', async () => {
    const client = await connect(await start({ ACCESS_MODE: 'full' }));
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS, ...FULL_TOOLS].sort());
    for (const t of tools) expect(t.annotations?.destructiveHint ?? false, t.name).toBe(FULL_TOOLS.includes(t.name));
    const daily = tools.find((t) => t.name === 'get_daily_note')!;
    expect(Object.keys((daily.inputSchema as { properties?: object }).properties ?? {})).toContain('create_if_missing');
    const r = await client.callTool({ name: 'move_note', arguments: { path: 'Lonely.md', folder: 'Beds' } });
    expect(r.isError).toBeFalsy();
    expect(fs.existsSync(path.join(tv.dir, 'Beds', 'Lonely.md'))).toBe(true);
    await client.close();
  });

  it('the tool runner refuses full tools outside full mode', async () => {
    const { ops, status } = makeOps(tv.dir, { ACCESS_MODE: 'write' });
    const def = toolDefs(ops, status, 'write').find((d) => d.name === 'delete_note')!;
    const r = await runTool(def, { path: 'Lonely.md' }, status, 'write');
    expect(r.isError).toBe(true);
    expect(fs.existsSync(path.join(tv.dir, 'Lonely.md'))).toBe(true);
  });

  it('unknown modes are refused', () => {
    expect(() => testConfig(tv.dir, { ACCESS_MODE: 'admin' })).toThrow(ConfigError);
    expect(() => testConfig(tv.dir, { ACCESS_MODE: 'admin' })).toThrow(/must be 'read', 'write' or 'full'/);
    expect(testConfig(tv.dir, { ACCESS_MODE: 'FULL' }).accessMode).toBe('full');
  });

  it('the server process exits with an error for an unknown mode', { timeout: 60000 }, async () => {
    // Compile to a throwaway folder and run the real entry point.
    const root = path.join(import.meta.dirname, '..');
    const outDir = path.join(tv.base, 'dist');
    await new Promise<void>((resolve, reject) =>
      execFile(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', path.join(root, 'tsconfig.json'), '--outDir', outDir], (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(tv.base, 'node_modules'));
    const entry = path.join(outDir, 'index.js');
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [entry],
        { env: { ...process.env, VAULT_DIR: tv.dir, MCP_TOKEN: TOKEN, ACCESS_MODE: 'admin', PORT: '0' } },
        (err, _out, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr: String(stderr) }),
      );
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/ACCESS_MODE must be/);
  });
});

describe('config checks', () => {
  it('requires a long token and an existing vault', () => {
    expect(() => loadConfig({ VAULT_DIR: tv.dir, MCP_TOKEN: 'short' })).toThrow(/MCP_TOKEN/);
    expect(() => loadConfig({ VAULT_DIR: path.join(tv.base, 'missing'), MCP_TOKEN: TOKEN })).toThrow(/VAULT_DIR/);
    expect(() => loadConfig({ VAULT_DIR: tv.dir, MCP_TOKEN: TOKEN, READONLY_DIRS: '../x' })).toThrow(/READONLY_DIRS/);
  });
  it('defaults to read mode', () => {
    expect(loadConfig({ VAULT_DIR: tv.dir, MCP_TOKEN: TOKEN }).accessMode).toBe('read');
  });
});

describe('tool results over MCP', () => {
  it('read_image returns MCP image content', async () => {
    const client = await connect(await start());
    const r = await client.callTool({ name: 'read_image', arguments: { note: 'Beds/Tomato Bed.md', name: 'diagram.png' } });
    const content = r.content as { type: string; mimeType?: string; data?: string }[];
    const img = content.find((c) => c.type === 'image')!;
    expect(img.mimeType).toBe('image/png');
    expect(Buffer.from(img.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    await client.close();
  });

  it('search_notes refuses folders that are symlinks out of the vault or into dot folders', async () => {
    const client = await connect(await start());
    for (const folder of ['EscapeDir', 'ConfigLink', '.obsidian', '../outside']) {
      const r = await client.callTool({ name: 'search_notes', arguments: { query: 'outside-secret-marker', folder } });
      const text = (r.content as { text: string }[]).map((c) => c.text).join();
      expect(r.isError, folder).toBe(true);
      expect(text).not.toContain('secret.md');
    }
    const ok = await client.callTool({ name: 'search_notes', arguments: { query: 'heirloom', folder: 'Beds' } });
    expect(ok.isError).toBeFalsy();
    await client.close();
  });

  it('path errors come back as tool errors without host paths', async () => {
    const client = await connect(await start());
    const r = await client.callTool({ name: 'read_note', arguments: { path: '../outside/secret.md' } });
    expect(r.isError).toBe(true);
    const text = (r.content as { text: string }[]).map((c) => c.text).join();
    expect(text).not.toContain(tv.base);
    await client.close();
  });
});
