import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchNotes } from '../src/search.js';
import { makeVault, type TestVault } from './helpers.js';

let tv: TestVault;
beforeEach(() => {
  tv = makeVault();
});
afterEach(() => fs.rmSync(tv.base, { recursive: true, force: true }));

const search = (query: string, extra: Partial<Parameters<typeof searchNotes>[2]> = {}) =>
  searchNotes('rg', tv.dir, { query, limit: 50, ...extra });

describe('search_notes', () => {
  it('finds fixed strings case-insensitively and skips dot folders', async () => {
    const r = await search('HEIRLOOM');
    expect(r.hits.map((h) => h.path)).toEqual(['Seed Catalog.md']);
    expect(r.hits[0]!.line).toBe(7);
  });

  it('treats regex characters literally by default', async () => {
    expect((await search('[[Compost Heap]]')).hits.length).toBeGreaterThan(0);
    expect((await search('Ex.ry')).hits).toEqual([]);
    expect((await search('Ev.ry', { regex: true })).hits.map((h) => h.path)).toContain('Compost Heap.md');
  });

  it('does not treat a leading dash as an option', async () => {
    const r = await search('--files');
    expect(r.hits).toEqual([]);
  });

  it('does not follow symlinks out of the vault', async () => {
    expect((await search('outside-secret-marker')).hits).toEqual([]);
  });

  it('limits to a folder and caps results', async () => {
    const r = await search('#', { folder: 'Beds' });
    expect(r.hits.every((h) => h.path.startsWith('Beds/'))).toBe(true);
    const capped = await search('e', { limit: 2 });
    expect(capped.hits).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('ignores .gitignore files inside the vault', async () => {
    fs.writeFileSync(`${tv.dir}/.gitignore`, '*.md\n');
    expect((await search('heirloom')).hits).toHaveLength(1);
  });
});
