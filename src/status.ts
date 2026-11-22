import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import type { Vault } from './vault.js';

export interface VaultStatus {
  sync_unit: string | null;
  sync_unit_state: string; // active, inactive, failed, ..., 'unknown' if systemctl is unavailable, 'not checked' if disabled
  newest_change: string | null; // ISO time of the most recently modified file
  newest_change_path: string | null;
  last_sync_activity: { time: string; line: string } | { unavailable: string };
  stale: boolean;
  stale_reasons: string[];
  stale_hours: number;
  checked_at: string;
}

export type ExecFn = (file: string, args: string[]) => Promise<{ code: number; stdout: string; error?: NodeJS.ErrnoException }>;

export const realExec: ExecFn = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 5000 }, (err, stdout) => {
      if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
        resolve({ code: -1, stdout: String(stdout ?? ''), error: err as NodeJS.ErrnoException });
      } else {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout ?? '') });
      }
    });
  });

const CACHE_MS = 60_000;

/**
 * Last line of the newest `sync.log` written by the obsidian-headless CLI (`ob`).
 * `ob sync` appends lines like "[2026-01-01T00:00:00.000Z] message" to <ob config>/sync/<vault id>/sync.log.
 * Only file metadata and that log are read; ob's config.json and auth token are never opened.
 */
export async function lastSyncActivity(obConfigDir: string): Promise<VaultStatus['last_sync_activity']> {
  const syncDir = path.join(obConfigDir, 'sync');
  let dirs: string[];
  try {
    dirs = await fs.readdir(syncDir);
  } catch {
    return { unavailable: 'no obsidian-headless sync folder found for this user' };
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const d of dirs) {
    const file = path.join(syncDir, d, 'sync.log');
    try {
      const st = await fs.stat(file);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { file, mtimeMs: st.mtimeMs };
    } catch {
      /* no log for this vault */
    }
  }
  if (!newest) return { unavailable: 'no sync.log found' };
  const fh = await fs.open(newest.file, 'r');
  try {
    const st = await fh.stat();
    const len = Math.min(st.size, 8192);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] ?? '';
    const m = /^\[([^\]]+)\]\s?(.*)$/.exec(last);
    const time = m && !Number.isNaN(Date.parse(m[1]!)) ? new Date(m[1]!).toISOString() : new Date(newest.mtimeMs).toISOString();
    return { time, line: (m ? m[2]! : last).slice(0, 200) };
  } finally {
    await fh.close();
  }
}

export class StatusChecker {
  private cached: { at: number; status: VaultStatus } | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly cfg: Pick<Config, 'syncUnit' | 'staleHours' | 'obConfigDir' | 'systemctlPath'>,
    private readonly exec: ExecFn = realExec,
    private readonly now: () => number = Date.now,
  ) {}

  async unitState(): Promise<string> {
    if (!this.cfg.syncUnit) return 'not checked';
    // `systemctl is-active` works without privileges. Exit 0 means active; stdout carries the state either way.
    const r = await this.exec(this.cfg.systemctlPath, ['is-active', '--', this.cfg.syncUnit]);
    if (r.error) return 'unknown';
    return r.stdout.trim().split('\n')[0] || (r.code === 0 ? 'active' : 'inactive');
  }

  async get(force = false): Promise<VaultStatus> {
    const t = this.now();
    if (!force && this.cached && t - this.cached.at < CACHE_MS) return this.cached.status;

    const [state, files, activity] = await Promise.all([
      this.unitState(),
      this.vault.listFiles(),
      lastSyncActivity(this.cfg.obConfigDir).catch(() => ({ unavailable: 'could not read sync.log' })),
    ]);
    let newest: { rel: string; mtimeMs: number } | null = null;
    for (const f of files) if (!newest || f.mtimeMs > newest.mtimeMs) newest = { rel: f.rel, mtimeMs: f.mtimeMs };

    const reasons: string[] = [];
    if (this.cfg.syncUnit && state !== 'active') reasons.push(`sync unit '${this.cfg.syncUnit}' is ${state}`);
    const limitMs = this.cfg.staleHours * 3600_000;
    if (!newest) reasons.push('vault has no files');
    else if (t - newest.mtimeMs > limitMs) {
      const hours = Math.floor((t - newest.mtimeMs) / 3600_000);
      reasons.push(`newest change in the vault is ${hours} hours old (limit ${this.cfg.staleHours})`);
    }

    const status: VaultStatus = {
      sync_unit: this.cfg.syncUnit || null,
      sync_unit_state: state,
      newest_change: newest ? new Date(newest.mtimeMs).toISOString() : null,
      newest_change_path: newest?.rel ?? null,
      last_sync_activity: activity,
      stale: reasons.length > 0,
      stale_reasons: reasons,
      stale_hours: this.cfg.staleHours,
      checked_at: new Date(t).toISOString(),
    };
    this.cached = { at: t, status };
    return status;
  }

  /** One-line warning to put at the top of every tool result, or null when the vault looks current. */
  async warning(): Promise<string | null> {
    const s = await this.get();
    return s.stale ? `WARNING: vault may be out of date (${s.stale_reasons.join('; ')}).` : null;
  }
}
