import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lastSyncActivity, StatusChecker, type ExecFn } from '../src/status.js';
import { allowedIn, runTool, toolDefs } from '../src/tools.js';
import { makeOps, makeVault, type TestVault } from './helpers.js';

let tv: TestVault;
beforeEach(() => {
  tv = makeVault();
});
afterEach(() => fs.rmSync(tv.base, { recursive: true, force: true }));

const execReturning = (code: number, stdout: string): ExecFn & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = (async (_file: string, args: string[]) => {
    calls.push(args);
    return { code, stdout };
  }) as ExecFn & { calls: string[][] };
  fn.calls = calls;
  return fn;
};

const missingSystemctl: ExecFn = async () => ({ code: -1, stdout: '', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });

describe('vault_status', () => {
  it('reports an active unit and a fresh vault as not stale', async () => {
    const exec = execReturning(0, 'active\n');
    const { status } = makeOps(tv.dir, { SYNC_UNIT: 'obsidian-sync', STALE_HOURS: '24' }, exec);
    const s = await status.get();
    expect(exec.calls[0]).toEqual(['is-active', '--', 'obsidian-sync']);
    expect(s).toMatchObject({ sync_unit: 'obsidian-sync', sync_unit_state: 'active', stale: false });
    expect(s.newest_change).toBeTruthy();
    expect(await status.warning()).toBeNull();
  });

  it('flags an inactive unit as stale', async () => {
    const { status } = makeOps(tv.dir, { SYNC_UNIT: 'obsidian-sync' }, execReturning(3, 'inactive\n'));
    const s = await status.get();
    expect(s.sync_unit_state).toBe('inactive');
    expect(s.stale).toBe(true);
    expect(await status.warning()).toMatch(/^WARNING: .*obsidian-sync' is inactive/);
  });

  it('treats a missing systemctl as unknown and stale', async () => {
    const { status } = makeOps(tv.dir, { SYNC_UNIT: 'obsidian-sync' }, missingSystemctl);
    const s = await status.get();
    expect(s.sync_unit_state).toBe('unknown');
    expect(s.stale).toBe(true);
  });

  it('flags a vault whose newest change is older than STALE_HOURS', async () => {
    const old = new Date(Date.now() - 48 * 3600_000);
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(p);
        else fs.utimesSync(p, old, old);
      }
    };
    walk(tv.dir);
    const { status } = makeOps(tv.dir, { SYNC_UNIT: 'obsidian-sync', STALE_HOURS: '24' }, execReturning(0, 'active\n'));
    const s = await status.get();
    expect(s.stale).toBe(true);
    expect(s.stale_reasons.join()).toMatch(/48 hours old \(limit 24\)/);
  });

  it('caches the check for about a minute', async () => {
    const exec = execReturning(0, 'active\n');
    let now = Date.now();
    const { vault, cfg } = makeOps(tv.dir, { SYNC_UNIT: 'obsidian-sync' });
    const checker = new StatusChecker(vault, cfg, exec, () => now);
    await checker.get();
    await checker.get();
    expect(exec.calls).toHaveLength(1);
    now += 61_000;
    await checker.get();
    expect(exec.calls).toHaveLength(2);
  });

  it('reads the last sync activity from the ob sync log', async () => {
    const ob = path.join(tv.base, 'ob-config');
    fs.mkdirSync(path.join(ob, 'sync', 'vault-id-1'), { recursive: true });
    fs.writeFileSync(path.join(ob, 'sync', 'vault-id-1', 'sync.log'), '[2026-03-01T10:00:00.000Z] Starting sync:\n[2026-03-01T10:05:00.000Z] Fully synced\n');
    expect(await lastSyncActivity(ob)).toEqual({ time: '2026-03-01T10:05:00.000Z', line: 'Fully synced' });
    const { status } = makeOps(tv.dir);
    expect((await status.get()).last_sync_activity).toEqual({ time: '2026-03-01T10:05:00.000Z', line: 'Fully synced' });
  });

  it('says so when no sync log exists', async () => {
    expect(await lastSyncActivity(path.join(tv.base, 'nope'))).toHaveProperty('unavailable');
  });
});

describe('tool wrapper', () => {
  it('starts every result with the stale warning when stale', async () => {
    const { ops, status } = makeOps(tv.dir, { SYNC_UNIT: 'obsidian-sync' }, execReturning(3, 'failed\n'));
    const def = toolDefs(ops, status, 'write').find((d) => d.name === 'list_notes')!;
    const r = await runTool(def, {}, status, 'write');
    expect(r.content[0]!.type).toBe('text');
    expect((r.content[0] as { text: string }).text).toMatch(/^WARNING: vault may be out of date/);
    expect(r.content).toHaveLength(2);
  });

  it('adds no warning when fresh', async () => {
    const { ops, status } = makeOps(tv.dir);
    const def = toolDefs(ops, status, 'write').find((d) => d.name === 'list_notes')!;
    const r = await runTool(def, {}, status, 'write');
    expect(r.content).toHaveLength(1);
  });

  it('refuses a write tool in read mode even if called directly', async () => {
    const { ops, status } = makeOps(tv.dir, { ACCESS_MODE: 'read' });
    const def = toolDefs(ops, status, 'write').find((d) => d.name === 'create_note')!;
    const r = await runTool(def, { path: 'x.md', content: 'x' }, status, 'read');
    expect(r.isError).toBe(true);
    expect(fs.existsSync(path.join(tv.dir, 'x.md'))).toBe(false);
    expect(allowedIn('write', 'read')).toBe(false);
  });

  it('hides internal error details', async () => {
    const { ops, status } = makeOps(tv.dir);
    const def = { name: 'boom', mode: 'read' as const, description: '', input: undefined as never, run: async () => { throw new Error(`/secret/host/path`); } };
    const orig = console.error;
    console.error = () => {};
    const r = await runTool(def, {}, status, 'read');
    console.error = orig;
    expect(r).toEqual({ content: [{ type: 'text', text: 'Internal error' }], isError: true });
  });
});
