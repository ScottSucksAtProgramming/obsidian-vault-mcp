import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkRelPath, VaultPaths } from '../src/paths.js';
import { makeOps, makeVault, type TestVault } from './helpers.js';

let tv: TestVault;
beforeEach(() => {
  tv = makeVault();
});
afterEach(() => fs.rmSync(tv.base, { recursive: true, force: true }));

describe('checkRelPath', () => {
  it.each([
    ['/etc/passwd', /absolute/],
    ['C:/Windows', /absolute/],
    ['../outside/secret.md', /Invalid path segment/],
    ['Beds/../../outside/secret.md', /Invalid path segment/],
    ['Beds//Tomato Bed.md', /Invalid path segment/],
    ['./Compost Heap.md', /Invalid path segment/],
    ['.obsidian/app.json', /Dot-prefixed/],
    ['.trash/Old Note.md', /Dot-prefixed/],
    ['Beds/.hidden.md', /Dot-prefixed/],
    ['Beds\\Tomato Bed.md', /forward slashes/],
    ['', /required/],
    ['a\0b.md', /NUL/],
  ])('rejects %j', (input, msg) => {
    expect(() => checkRelPath(input)).toThrow(msg);
  });

  it('accepts normal paths', () => {
    expect(checkRelPath('Beds/Tomato Bed.md')).toBe('Beds/Tomato Bed.md');
    expect(checkRelPath('Beds/')).toBe('Beds');
  });
});

describe('VaultPaths.resolveExisting', () => {
  const vp = () => new VaultPaths(tv.dir, ['Almanac']);

  it('resolves files inside the vault', async () => {
    const r = await vp().resolveExisting('Beds/Tomato Bed.md');
    expect(r.abs).toBe(path.join(tv.dir, 'Beds', 'Tomato Bed.md'));
  });

  it('follows a symlink that stays inside the vault', async () => {
    const r = await vp().resolveExisting('Heap Link.md');
    expect(r.abs).toBe(path.join(tv.dir, 'Compost Heap.md'));
  });

  it('refuses symlinks leading out of the vault', async () => {
    await expect(vp().resolveExisting('Escape.md')).rejects.toThrow(/outside the vault/);
    await expect(vp().resolveExisting('EscapeDir/secret.md')).rejects.toThrow(/outside the vault/);
  });

  it('refuses symlinks into dot folders', async () => {
    await expect(vp().resolveExisting('ConfigLink/app.json')).rejects.toThrow(/Dot-prefixed/);
    await expect(vp().resolveExisting('config.md')).rejects.toThrow(/Dot-prefixed/);
  });
});

describe('VaultPaths.resolveForWrite', () => {
  const vp = () => new VaultPaths(tv.dir, ['Almanac']);

  it('allows new notes in new folders', async () => {
    const r = await vp().resolveForWrite('Beds/New/Idea.md');
    expect(r.exists).toBe(false);
    expect(r.abs).toBe(path.join(tv.dir, 'Beds', 'New', 'Idea.md'));
  });

  it('refuses read-only folders and their subfolders', async () => {
    await expect(vp().resolveForWrite('Almanac/Frost Dates.md')).rejects.toThrow(/read-only/);
    await expect(vp().resolveForWrite('Almanac/Sub/New.md')).rejects.toThrow(/read-only/);
  });

  it('does not treat a folder with a shared prefix as read-only', async () => {
    await expect(vp().resolveForWrite('Almanac2/New.md')).resolves.toMatchObject({ exists: false });
  });

  it('refuses non-Markdown files', async () => {
    await expect(vp().resolveForWrite('Media/new.png')).rejects.toThrow(/Only .md/);
    await expect(vp().resolveForWrite('notes.txt')).rejects.toThrow(/Only .md/);
  });

  it('refuses writing through symlinks, inside or out', async () => {
    await expect(vp().resolveForWrite('Escape.md')).rejects.toThrow(/symlink/);
    await expect(vp().resolveForWrite('Heap Link.md')).rejects.toThrow(/symlink/);
  });

  it('refuses a parent folder that is a symlink leading out', async () => {
    await expect(vp().resolveForWrite('EscapeDir/new.md')).rejects.toThrow(/outside the vault/);
    await expect(vp().resolveForWrite('EscapeDir/deeper/new.md')).rejects.toThrow(/outside the vault/);
    await expect(vp().resolveForWrite('ConfigLink/new.md')).rejects.toThrow(/Dot-prefixed/);
  });

  it('refuses a read-only folder reached through a symlink', async () => {
    fs.symlinkSync(path.join(tv.dir, 'Almanac'), path.join(tv.dir, 'AlmanacLink'));
    await expect(vp().resolveForWrite('AlmanacLink/New.md')).rejects.toThrow(/read-only/);
  });
});

describe('vault listing', () => {
  it('skips dot folders and outside symlinks but keeps inside symlinks', async () => {
    const { vault } = makeOps(tv.dir);
    const rels = (await vault.listFiles()).map((f) => f.rel);
    expect(rels).toContain('Heap Link.md');
    expect(rels).toContain('Compost Heap.md');
    expect(rels.some((r) => r.startsWith('.'))).toBe(false);
    expect(rels).not.toContain('Escape.md');
    expect(rels).not.toContain('config.md');
    expect(rels.some((r) => r.startsWith('EscapeDir'))).toBe(false);
    expect(rels).not.toContain('Media/escape.png');
  });
});
