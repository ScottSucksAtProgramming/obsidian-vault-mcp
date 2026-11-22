import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/vault.js';
import { makeOps, makeVault, type TestVault } from './helpers.js';

let tv: TestVault;
beforeEach(() => {
  tv = makeVault();
});
afterEach(() => fs.rmSync(tv.base, { recursive: true, force: true }));

const read = (rel: string) => fs.readFileSync(path.join(tv.dir, rel), 'utf8');
const setMtime = (rel: string, iso: string) => {
  const t = new Date(iso);
  fs.utimesSync(path.join(tv.dir, rel), t, t);
};

describe('read tools', () => {
  it('read_note returns content, parsed frontmatter and hash', async () => {
    const { ops } = makeOps(tv.dir);
    const r = (await ops.readNote('Beds/Tomato Bed.md', 'full')) as any;
    expect(r.frontmatter.type).toBe('project');
    expect(r.hash).toBe(sha256(read('Beds/Tomato Bed.md')));
    const outline = (await ops.readNote('Compost Heap.md', 'outline')) as any;
    expect(outline.headings.map((h: any) => h.text)).toEqual(['Compost Heap', 'Inputs', 'Greens', 'Browns', 'Turning']);
    const section = (await ops.readNote('Compost Heap.md', 'section', 'Inputs')) as any;
    expect(section.section).toContain('Dry leaves.');
    expect(section.section).not.toContain('Every two weeks');
  });

  it('read_note reports malformed frontmatter but still returns the body', async () => {
    const { ops } = makeOps(tv.dir);
    const r = (await ops.readNote('Broken.md', 'full')) as any;
    expect(r.frontmatter).toBeNull();
    expect(r.frontmatter_error).toBeTruthy();
    expect(r.content).toContain('Body of a note');
  });

  it('read_note refuses notes over READ_MAX_BYTES', async () => {
    const { ops } = makeOps(tv.dir, { READ_MAX_BYTES: '10' });
    await expect(ops.readNote('Compost Heap.md', 'full')).rejects.toThrow(/READ_MAX_BYTES/);
  });

  it('read_note refuses dot paths and traversal', async () => {
    const { ops } = makeOps(tv.dir);
    await expect(ops.readNote('.trash/Old Note.md', 'full')).rejects.toThrow(/Dot-prefixed/);
    await expect(ops.readNote('../outside/secret.md', 'full')).rejects.toThrow();
    await expect(ops.readNote('Escape.md', 'full')).rejects.toThrow(/outside the vault/);
  });

  it('list_notes filters by folder and glob', async () => {
    const { ops } = makeOps(tv.dir);
    const beds = await ops.listNotes('Beds');
    expect(beds.notes.map((n) => n.path)).toEqual(['Beds/Pepper Row.md', 'Beds/Tomato Bed.md']);
    const glob = await ops.listNotes(undefined, '*Bed*');
    expect(glob.notes.map((n) => n.path)).toEqual(['Beds/Tomato Bed.md']);
    const all = await ops.listNotes();
    expect(all.notes.some((n) => n.path.startsWith('.'))).toBe(false);
  });

  it('recent_notes and stale_notes use modification time', async () => {
    const { ops } = makeOps(tv.dir);
    for (const f of (await ops.listNotes()).notes) setMtime(f.path, '2025-01-01T00:00:00Z');
    setMtime('Compost Heap.md', '2026-04-01T00:00:00Z');
    const recent = await ops.recentNotes('2026-03-15', 'modified');
    // The in-vault symlink points at the same file, so it shares its time.
    expect(recent.notes.map((n) => n.path).sort()).toEqual(['Compost Heap.md', 'Heap Link.md']);
    const stale = await ops.staleNotes('2026-03-15');
    expect(stale.notes.map((n) => n.path)).not.toContain('Compost Heap.md');
    expect(stale.total).toBeGreaterThan(5);
    await expect(ops.recentNotes('not a date', 'modified')).rejects.toThrow(/date/);
  });

  it('tags include frontmatter, inline and nested tags', async () => {
    const { ops } = makeOps(tv.dir);
    const tags = (await ops.listTags()).tags.map((t) => t.tag);
    expect(tags).toEqual(expect.arrayContaining(['garden/vegetables', 'summer', 'watering', 'garden/soil', 'reference']));
    expect(tags).not.toContain('notatag');
    const nested = await ops.searchByTag('#garden', true);
    expect(nested.notes.map((n) => n.path).sort()).toEqual(['Beds/Pepper Row.md', 'Beds/Tomato Bed.md', 'Compost Heap.md', 'Heap Link.md']);
    const exact = await ops.searchByTag('garden', false);
    expect(exact.total).toBe(0);
  });

  it('properties: keys, values, and search', async () => {
    const { ops } = makeOps(tv.dir);
    const keys = (await ops.listPropertyKeys()).keys.map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining(['type', 'status', 'tags', 'planted']));
    const values = await ops.listPropertyValues('type');
    expect(values.values).toEqual(
      expect.arrayContaining([
        { value: 'project', notes: 2 },
        { value: 'reference', notes: 2 },
      ]),
    );
    const projects = await ops.searchByProperty('type', 'Project');
    expect(projects.notes.map((n) => n.path).sort()).toEqual(['Beds/Pepper Row.md', 'Beds/Tomato Bed.md']);
    const listMatch = await ops.searchByProperty('tags', 'summer');
    expect(listMatch.notes.map((n) => n.path)).toEqual(['Beds/Tomato Bed.md']);
    const hasKey = await ops.searchByProperty('planted', undefined);
    expect(hasKey.total).toBe(1);
  });

  it('links: outgoing, backlinks, orphans', async () => {
    const { ops } = makeOps(tv.dir);
    const out = await ops.outgoingLinks('Beds/Tomato Bed.md');
    const resolved = out.links.map((l) => l.resolved);
    expect(resolved).toEqual(expect.arrayContaining(['Compost Heap.md', 'Seed Catalog.md', 'Beds/Pepper Row.md', 'Media/diagram.png']));
    expect(out.links.find((l) => l.target === 'Not A Link')).toBeUndefined();

    const back = await ops.backlinks('Beds/Tomato Bed.md');
    expect(back.backlinks.map((b) => b.path).sort()).toEqual(['Beds/Pepper Row.md', 'Logbook/2026-03-01.md']);

    const orphans = (await ops.orphans()).notes;
    expect(orphans).toContain('Lonely.md');
    expect(orphans).not.toContain('Compost Heap.md');
  });
});

describe('write tools', () => {
  it('create_note writes a new note and refuses to overwrite', async () => {
    const { ops, logs } = makeOps(tv.dir);
    const r = await ops.createNote({ path: 'Beds/Squash.md', content: '# Squash\n', properties: { type: 'project' } });
    expect(read('Beds/Squash.md')).toBe('---\ntype: project\n---\n# Squash\n');
    expect(r.hash).toBe(sha256(read('Beds/Squash.md')));
    await expect(ops.createNote({ path: 'Beds/Squash.md', content: 'x' })).rejects.toThrow(/already exists/);
    expect(read('Beds/Squash.md')).toContain('# Squash');
    const log = JSON.parse(logs[0]!);
    expect(log).toMatchObject({ event: 'write', tool: 'create_note', path: 'Beds/Squash.md', sha256: r.hash });
    expect(logs).toHaveLength(1);
  });

  it('create_note with a title goes to INBOX_DIR', async () => {
    const { ops } = makeOps(tv.dir);
    const r = await ops.createNote({ title: 'Idea', content: 'hi\n' });
    expect(r.path).toBe('Seedlings/Idea.md');
    await expect(ops.createNote({ title: '../escape', content: 'x' })).rejects.toThrow(/characters/);
  });

  it('create_note refuses read-only folders, dot paths, non-md, and oversize content', async () => {
    const { ops } = makeOps(tv.dir, { WRITE_MAX_BYTES: '50' });
    await expect(ops.createNote({ path: 'Almanac/New.md', content: 'x' })).rejects.toThrow(/read-only/);
    await expect(ops.createNote({ path: '.obsidian/evil.md', content: 'x' })).rejects.toThrow(/Dot-prefixed/);
    await expect(ops.createNote({ path: 'EscapeDir/new.md', content: 'x' })).rejects.toThrow(/outside/);
    await expect(ops.createNote({ path: 'big.md', content: 'x'.repeat(100) })).rejects.toThrow(/WRITE_MAX_BYTES/);
    expect(fs.existsSync(path.join(tv.outside, 'new.md'))).toBe(false);
  });

  it('create_note under concurrency creates exactly once', async () => {
    const { ops } = makeOps(tv.dir);
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => ops.createNote({ path: 'Race.md', content: `v${i}` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('append_to_note appends at the end or at the end of a section', async () => {
    const { ops } = makeOps(tv.dir);
    await ops.appendToNote('Compost Heap.md', '- end line');
    expect(read('Compost Heap.md').endsWith('Every two weeks.\n- end line\n')).toBe(true);
    await ops.appendToNote('Compost Heap.md', 'More greens.', 'Greens');
    expect(read('Compost Heap.md')).toContain('Grass clippings, peels.\nMore greens.\n\n### Browns');
    await ops.appendToNote('Beds/Tomato Bed.md', '- Prune', 'Plan');
    const t = read('Beds/Tomato Bed.md');
    expect(t).toContain('- Stake the vines #watering\n- Prune\n\n## Harvest');
    expect(t.startsWith('---\n# Bed metadata\n')).toBe(true);
    await expect(ops.appendToNote('Compost Heap.md', 'x', 'Nope')).rejects.toThrow(/Heading not found/);
    await expect(ops.appendToNote('Almanac/Frost Dates.md', 'x')).rejects.toThrow(/read-only/);
    await expect(ops.appendToNote('Missing.md', 'x')).rejects.toThrow(/Not found/);
  });

  it('replace_in_note needs a unique match and the current hash', async () => {
    const { ops } = makeOps(tv.dir);
    const before = read('Compost Heap.md');
    const hash = sha256(before);
    await expect(ops.replaceInNote('Compost Heap.md', 'Every two weeks.', 'Weekly.', 'stale')).rejects.toThrow(/hash mismatch/);
    expect(read('Compost Heap.md')).toBe(before);
    await expect(ops.replaceInNote('Compost Heap.md', '###', 'x', hash)).rejects.toThrow(/more than once/);
    await expect(ops.replaceInNote('Compost Heap.md', 'absent', 'x', hash)).rejects.toThrow(/not found/);
    const r = await ops.replaceInNote('Compost Heap.md', 'Every two weeks.', 'Weekly.', hash);
    expect(read('Compost Heap.md')).toContain('Weekly.');
    // The old hash is now stale.
    await expect(ops.replaceInNote('Compost Heap.md', 'Weekly.', 'Daily.', hash)).rejects.toThrow(/hash mismatch/);
    await ops.replaceInNote('Compost Heap.md', 'Weekly.', 'Daily.', r.hash);
  });

  it('update_properties keeps other keys, order and comments', async () => {
    const { ops } = makeOps(tv.dir);
    await ops.updateProperties('Beds/Tomato Bed.md', { status: 'harvesting', yield: 3 }, ['planted']);
    const t = read('Beds/Tomato Bed.md');
    expect(t).toContain('# Bed metadata\n');
    expect(t).toContain('status: harvesting # still growing');
    expect(t).not.toContain('planted');
    const fm = t.split('---')[1]!;
    expect(fm.indexOf('type:')).toBeLessThan(fm.indexOf('status:'));
    expect(fm.indexOf('status:')).toBeLessThan(fm.indexOf('tags:'));
    expect(fm.indexOf('tags:')).toBeLessThan(fm.indexOf('yield:'));
    expect(t).toContain('# Tomato Bed\n\nSee [[Compost Heap]]');
  });

  it('update_properties adds frontmatter to a note without it', async () => {
    const { ops } = makeOps(tv.dir);
    await ops.updateProperties('Lonely.md', { type: 'idea' }, undefined);
    expect(read('Lonely.md')).toBe('---\ntype: idea\n---\n# Lonely\n\nNobody links here.\n');
  });

  it('update_properties refuses malformed frontmatter and leaves the file alone', async () => {
    const { ops } = makeOps(tv.dir);
    const before = read('Broken.md');
    await expect(ops.updateProperties('Broken.md', { a: 1 }, undefined)).rejects.toThrow(/malformed/);
    expect(read('Broken.md')).toBe(before);
  });

  it('writes leave no temp files behind', async () => {
    const { ops } = makeOps(tv.dir);
    await ops.appendToNote('Compost Heap.md', 'x');
    await ops.createNote({ path: 'New.md', content: 'x' });
    const leftovers = fs.readdirSync(tv.dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});
