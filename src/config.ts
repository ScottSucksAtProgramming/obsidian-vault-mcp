import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type AccessMode = 'read' | 'write' | 'full';

export interface Config {
  vaultDir: string; // absolute realpath
  port: number;
  host: string;
  token: string;
  accessMode: AccessMode;
  allowedHosts: string[];
  readonlyDirs: string[]; // vault-relative, no leading/trailing slash
  inboxDir: string; // vault-relative, '' means vault root
  dailyDir: string | undefined;
  dailyFormat: string | undefined;
  dailyTemplate: string | undefined;
  syncUnit: string; // '' disables the systemd check
  obConfigDir: string;
  staleHours: number;
  imageMaxBytes: number;
  readMaxBytes: number;
  writeMaxBytes: number;
  searchMaxResults: number;
  rgPath: string;
  systemctlPath: string;
  snapshotPath: string; // run before every full-mode change if it exists
}

export class ConfigError extends Error {}

const MIN_TOKEN_LENGTH = 32;

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number`);
  return n;
}

/** Normalise a configured vault-relative folder. Rejects anything that could escape the vault. */
export function normaliseRelDir(value: string, name: string): string {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  const parts = trimmed.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.startsWith('.')) {
      throw new ConfigError(`${name} must be a vault-relative folder without '.', '..' or dot-prefixed parts`);
    }
  }
  return parts.join('/');
}

function defaultObConfigDir(env: NodeJS.ProcessEnv): string {
  // Matches where the obsidian-headless CLI (`ob`) keeps its state.
  if (process.platform === 'linux') {
    return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'obsidian-headless');
  }
  return path.join(os.homedir(), '.obsidian-headless');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.ACCESS_MODE || 'read').trim().toLowerCase();
  if (mode !== 'read' && mode !== 'write' && mode !== 'full') {
    throw new ConfigError(`ACCESS_MODE must be 'read', 'write' or 'full' (got '${mode}')`);
  }

  const vaultRaw = env.VAULT_DIR;
  if (!vaultRaw) throw new ConfigError('VAULT_DIR is required');
  let vaultDir: string;
  try {
    vaultDir = fs.realpathSync(path.resolve(vaultRaw));
  } catch {
    throw new ConfigError('VAULT_DIR does not exist');
  }
  if (!fs.statSync(vaultDir).isDirectory()) throw new ConfigError('VAULT_DIR is not a directory');

  const token = env.MCP_TOKEN ?? '';
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`MCP_TOKEN is required and must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  return {
    vaultDir,
    port: intEnv(env, 'PORT', 8787),
    host: '127.0.0.1',
    token,
    accessMode: mode,
    allowedHosts: list(env.ALLOWED_HOSTS).length ? list(env.ALLOWED_HOSTS) : ['localhost', '127.0.0.1'],
    readonlyDirs: list(env.READONLY_DIRS).map((d) => normaliseRelDir(d, 'READONLY_DIRS')).filter(Boolean),
    inboxDir: normaliseRelDir(env.INBOX_DIR ?? '', 'INBOX_DIR'),
    dailyDir: env.DAILY_DIR !== undefined && env.DAILY_DIR !== '' ? normaliseRelDir(env.DAILY_DIR, 'DAILY_DIR') : undefined,
    dailyFormat: env.DAILY_FORMAT || undefined,
    dailyTemplate: env.DAILY_TEMPLATE || undefined,
    syncUnit: env.SYNC_UNIT ?? 'obsidian-sync',
    obConfigDir: env.OB_CONFIG_DIR || defaultObConfigDir(env),
    staleHours: intEnv(env, 'STALE_HOURS', 24),
    imageMaxBytes: intEnv(env, 'IMAGE_MAX_BYTES', 5 * 1024 * 1024),
    readMaxBytes: intEnv(env, 'READ_MAX_BYTES', 1024 * 1024),
    writeMaxBytes: intEnv(env, 'WRITE_MAX_BYTES', 1024 * 1024),
    searchMaxResults: intEnv(env, 'SEARCH_MAX_RESULTS', 200),
    rgPath: env.RG_PATH || 'rg',
    systemctlPath: env.SYSTEMCTL_PATH || 'systemctl',
    snapshotPath: env.SNAPSHOT_PATH || '/usr/local/bin/vault-snapshot',
  };
}
