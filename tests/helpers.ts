import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { Ops } from '../src/ops.js';
import { VaultPaths } from '../src/paths.js';
import { StatusChecker, type ExecFn } from '../src/status.js';
import { Vault } from '../src/vault.js';
import { Writer } from '../src/writer.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'vault');
export const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';

// Smallest valid files for each format (magic bytes plus a little padding).
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
export const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
export const GIF = Buffer.from('47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b', 'hex');
export const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.alloc(14)]);
export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>\n';

export interface TestVault {
  base: string; // temp folder holding the vault and an "outside" folder
  dir: string; // the vault
  outside: string;
}

/** Copy the synthetic fixture vault to a fresh temp folder and add images and symlinks. */
export function makeVault(): TestVault {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ovm-test-')));
  const dir = path.join(base, 'vault');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const media = path.join(dir, 'Media');
  fs.mkdirSync(path.join(media, 'Other'), { recursive: true });
  fs.writeFileSync(path.join(media, 'diagram.png'), PNG);
  fs.writeFileSync(path.join(media, 'Other', 'diagram.png'), PNG);
  fs.writeFileSync(path.join(media, 'photo.jpg'), JPEG);
  fs.writeFileSync(path.join(media, 'anim.gif'), GIF);
  fs.writeFileSync(path.join(media, 'leaf.webp'), WEBP);
  fs.writeFileSync(path.join(media, 'icon.svg'), SVG);
  fs.writeFileSync(path.join(media, 'fake.png'), 'this is text, not a png');

  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.md'), 'outside-secret-marker\n');
  fs.writeFileSync(path.join(outside, 'secret.png'), PNG);
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'Escape.md'));
  fs.symlinkSync(path.join(outside, 'secret.png'), path.join(media, 'escape.png'));
  fs.symlinkSync(outside, path.join(dir, 'EscapeDir'));
  fs.symlinkSync(path.join(dir, 'Compost Heap.md'), path.join(dir, 'Heap Link.md'));
  fs.symlinkSync(path.join(dir, '.obsidian'), path.join(dir, 'ConfigLink'));
  fs.symlinkSync(path.join(dir, '.obsidian', 'app.json'), path.join(dir, 'config.md'));
  return { base, dir, outside };
}

export function testConfig(dir: string, env: Record<string, string> = {}): Config {
  return loadConfig({
    VAULT_DIR: dir,
    MCP_TOKEN: TOKEN,
    ACCESS_MODE: 'write',
    READONLY_DIRS: 'Almanac',
    INBOX_DIR: 'Seedlings',
    SYNC_UNIT: '',
    OB_CONFIG_DIR: path.join(path.dirname(dir), 'ob-config'),
    STALE_HOURS: '1000000',
    // Never run a real snapshot script from tests.
    SNAPSHOT_PATH: path.join(path.dirname(dir), 'no-snapshot-script'),
    ...env,
  });
}

export const activeExec: ExecFn = async () => ({ code: 0, stdout: 'active\n' });

export function makeOps(dir: string, env: Record<string, string> = {}, exec: ExecFn = activeExec) {
  const cfg = testConfig(dir, env);
  const paths = new VaultPaths(cfg.vaultDir, cfg.readonlyDirs);
  const vault = new Vault(paths, cfg.readMaxBytes);
  const logs: string[] = [];
  const writer = new Writer(paths, cfg.writeMaxBytes, (l) => logs.push(l));
  const ops = new Ops(vault, writer, cfg, (l) => logs.push(l));
  const status = new StatusChecker(vault, cfg, exec);
  return { cfg, paths, vault, writer, ops, status, logs };
}
