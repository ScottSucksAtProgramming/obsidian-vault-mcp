import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeOps, makeVault, type TestVault } from './helpers.js';

let tv: TestVault;
beforeEach(() => {
  tv = makeVault();
});
afterEach(() => fs.rmSync(tv.base, { recursive: true, force: true }));

const abs = (rel: string) => path.join(tv.dir, ...rel.split('/'));
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
const exists = (rel: string) => fs.existsSync(abs(rel));
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text);
};
const full = (env: Record<string, string> = {}) => makeOps(tv.dir, { ACCESS_MODE: 'full', ...env });

/** A snapshot script that records each message, and whether Lonely.md existed when it ran. */
function recordingScript() {
  const log = path.join(tv.base, 'snapshots.log');
  const script = path.join(tv.base, 'vault-snapshot');
  fs.writeFileSync(script, `#!/bin/sh\nif [ -e Lonely.md ]; then s=present; else s=absent; fi\nprintf '%s [%s]\\n' "$1" "$s" >> '${log}'\n`, { mode: 0o755 });
  return { script, entries: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

const REFS = [
  '![[Tomato Bed]] [[Tomato Bed|my bed]] [[Beds/Tomato Bed]] [[Beds/Tomato Bed.md#Plan|x]]',
  '[bed](Beds/Tomato%20Bed.md) [bed2](<Beds/Tomato Bed.md#Harvest>) [[Nowhere]]',
  '`[[Tomato Bed]]`',
  '```',
  '[[Beds/Tomato Bed]]',
  '```',
  '',
].join('\n');

describe('rename_note', () => {
  it('renames the note and updates every link and embed that points to it', async () => {
    write('Refs.md', REFS);
    const { ops } = full();
    const r = await ops.mover.renameNote('Beds/Tomato Bed.md', 'Tomato Patch');
    expect(r).toMatchObject({ from: 'Beds/Tomato Bed.md', to: 'Beds/Tomato Patch.md', links_not_updated: [] });
    expect(exists('Beds/Tomato Bed.md')).toBe(false);
    expect(read('Beds/Tomato Patch.md')).toContain('# Tomato Bed');
    expect(read('Logbook/2026-03-01.md')).toContain('Watered the [[Tomato Patch]].');
    expect(read('Beds/Pepper Row.md')).toContain('[[Tomato Patch#Plan]]');
    expect(read('Refs.md')).toBe(
      [
        '![[Tomato Patch]] [[Tomato Patch|my bed]] [[Beds/Tomato Patch]] [[Beds/Tomato Patch.md#Plan|x]]',
        '[bed](Beds/Tomato%20Patch.md) [bed2](<Beds/Tomato Patch.md#Harvest>) [[Nowhere]]',
        '`[[Tomato Bed]]`',
        '```',
        '[[Beds/Tomato Bed]]',
        '```',
        '',
      ].join('\n'),
    );
    expect(r.links_updated.map((l) => l.path).sort()).toEqual(['Beds/Pepper Row.md', 'Logbook/2026-03-01.md', 'Refs.md']);
    expect(r.links_updated.find((l) => l.path === 'Refs.md')!.links).toBe(6);
  });

  it('updates aliased links inside tables, keeping the escaped pipe', async () => {
    write('Table.md', '| Bed | Notes |\n|---|---|\n| [[Tomato Bed\\|bed]] | [[Beds/Tomato Bed#Plan\\|plan]] |\n');
    const { ops } = full();
    await ops.mover.renameNote('Beds/Tomato Bed.md', 'Tomato Patch');
    expect(read('Table.md')).toBe('| Bed | Notes |\n|---|---|\n| [[Tomato Patch\\|bed]] | [[Beds/Tomato Patch#Plan\\|plan]] |\n');
  });

  it('accepts a name with .md and leaves unrelated notes untouched', async () => {
    const { ops } = full();
    const before = read('Compost Heap.md');
    await ops.mover.renameNote('Lonely.md', 'Alone.md');
    expect(exists('Alone.md')).toBe(true);
    expect(read('Compost Heap.md')).toBe(before);
  });

  it('reports links it cannot rewrite unambiguously instead of hiding them', async () => {
    // After this rename, [[Seed Catalog]] inside Beds/ would find Beds/Seed Catalog.md first.
    const { ops } = full();
    const r = await ops.mover.renameNote('Beds/Pepper Row.md', 'Seed Catalog');
    expect(read('Beds/Tomato Bed.md')).toContain('[pepper row](Seed%20Catalog.md)');
    expect(r.links_not_updated).toEqual([{ path: 'Beds/Tomato Bed.md', reason: expect.stringMatching(/could not be rewritten/) }]);
  });

  it('refuses bad names, existing notes and paths it must not touch', async () => {
    const { ops } = full();
    const cases: [string, string, RegExp][] = [
      ['Beds/Tomato Bed.md', 'Pepper Row', /Already exists/],
      ['Beds/Tomato Bed.md', 'Tomato Bed', /already has that name/],
      ['Beds/Tomato Bed.md', 'A#B', /not allow/],
      ['Beds/Tomato Bed.md', 'x/y', /not allow/],
      ['Beds/Tomato Bed.md', '.hidden', /not allow/],
      ['Beds/Tomato Bed.md', '', /not allow/],
      ['Media/diagram.png', 'pic', /Not a Markdown note/],
      ['.obsidian/app.json', 'x', /Dot-prefixed/],
      ['.trash/Old Note.md', 'x', /Dot-prefixed/],
      ['../outside/secret.md', 'x', /Invalid path/],
      ['/etc/passwd.md', 'x', /vault-relative/],
      ['Escape.md', 'x', /symlink/],
      ['Heap Link.md', 'x', /symlink/],
      ['EscapeDir/secret.md', 'x', /outside the vault/],
      ['Almanac/Frost Dates.md', 'x', /read-only/],
      ['Missing.md', 'x', /Not found/],
    ];
    for (const [p, name, err] of cases) await expect(ops.mover.renameNote(p, name), `${p} -> ${name}`).rejects.toThrow(err);
    expect(exists('Beds/Tomato Bed.md') && exists('Beds/Pepper Row.md') && exists('Almanac/Frost Dates.md')).toBe(true);
    expect(fs.existsSync(path.join(tv.outside, 'secret.md'))).toBe(true);
  });
});

describe('move_note', () => {
  it('moves a note, keeps its name, creates the folder, and fixes links the move would break', async () => {
    write('Refs.md', REFS);
    const { ops, logs } = full();
    const r = await ops.mover.moveNote('Beds/Tomato Bed.md', 'Archive/2026');
    expect(r).toMatchObject({ from: 'Beds/Tomato Bed.md', to: 'Archive/2026/Tomato Bed.md', links_not_updated: [] });
    // Its own links still resolve by name from the new folder, so the note is unchanged.
    expect(read('Archive/2026/Tomato Bed.md')).toContain('[pepper row](Pepper%20Row.md)');
    // Name-only links still resolve, so they stay as written.
    expect(read('Logbook/2026-03-01.md')).toContain('[[Tomato Bed]]');
    expect(read('Refs.md')).toContain('[[Archive/2026/Tomato Bed]] [[Archive/2026/Tomato Bed.md#Plan|x]]');
    expect(read('Refs.md')).toContain('[bed](Archive/2026/Tomato%20Bed.md)');
    expect(logs.some((l) => l.includes('"event":"move"') && l.includes('Archive/2026/Tomato Bed.md'))).toBe(true);
  });

  it("rewrites the moved note's own relative links that would break", async () => {
    const { ops } = full();
    const r = await ops.mover.moveNote('Beds/Pepper Row.md', 'Archive/2026');
    expect(read('Archive/2026/Pepper Row.md')).toContain('![](../../Media/photo.jpg)');
    expect(read('Archive/2026/Pepper Row.md')).toContain('[[Tomato Bed#Plan]]');
    expect(r.links_updated).toEqual([{ path: 'Archive/2026/Pepper Row.md', links: 1 }]);
  });

  it('reports notes in read-only folders whose links it could not fix, and leaves them alone', async () => {
    write('Almanac/Ref.md', 'See [[Beds/Tomato Bed]].\n');
    const frost = read('Almanac/Frost Dates.md');
    const { ops } = full();
    const r = await ops.mover.moveNote('Beds/Tomato Bed.md', 'Archive');
    expect(r.links_not_updated).toEqual([{ path: 'Almanac/Ref.md', reason: expect.stringMatching(/read-only/) }]);
    expect(read('Almanac/Ref.md')).toBe('See [[Beds/Tomato Bed]].\n');
    expect(read('Almanac/Frost Dates.md')).toBe(frost);
  });

  it("moves to the vault root with folder ''", async () => {
    const { ops } = full();
    await ops.mover.moveNote('Seedlings/Starter.md', '');
    expect(exists('Starter.md')).toBe(true);
  });

  it('refuses to overwrite, and refuses dot folders, symlinks, read-only folders and outside paths', async () => {
    write('Beds/Lonely.md', 'a different note\n');
    const { ops } = full();
    const cases: [string, string, RegExp][] = [
      ['Lonely.md', 'Beds', /Already exists/],
      ['Lonely.md', '', /already in that folder/],
      ['Lonely.md', '.obsidian', /Dot-prefixed/],
      ['Lonely.md', '.trash', /Dot-prefixed/],
      ['Lonely.md', 'Beds/.hidden', /Dot-prefixed/],
      ['Lonely.md', 'ConfigLink', /Dot-prefixed/],
      ['Lonely.md', 'EscapeDir', /outside the vault/],
      ['Lonely.md', 'EscapeDir/New', /outside the vault/],
      ['Lonely.md', '../outside', /Invalid path/],
      ['Lonely.md', 'Almanac', /read-only/],
      ['Lonely.md', 'Compost Heap.md', /not a folder/],
      ['Lonely.md', 'Bad#Folder', /not allow/],
      ['Almanac/Frost Dates.md', 'Beds', /read-only/],
      ['Escape.md', 'Beds', /symlink/],
    ];
    for (const [p, folder, err] of cases) await expect(ops.mover.moveNote(p, folder), `${p} -> ${folder}`).rejects.toThrow(err);
    expect(read('Beds/Lonely.md')).toBe('a different note\n');
    expect(read('Lonely.md')).toContain('Nobody links here.');
    expect(fs.readdirSync(tv.outside).sort()).toEqual(['secret.md', 'secret.png']);
    expect(fs.readdirSync(path.join(tv.dir, '.obsidian')).sort()).toEqual(['app.json', 'daily-notes.json']);
  });
});

describe('move_folder', () => {
  it('moves a folder with its contents and fixes path links into it', async () => {
    write('Refs.md', REFS);
    const { ops } = full();
    const r = await ops.mover.moveFolder('Beds', 'Garden/Beds');
    expect(r).toMatchObject({ from: 'Beds', to: 'Garden/Beds', files_moved: 2, links_not_updated: [] });
    expect(exists('Beds')).toBe(false);
    expect(exists('Garden/Beds/Tomato Bed.md') && exists('Garden/Beds/Pepper Row.md')).toBe(true);
    // Links between notes that moved together still resolve.
    expect(read('Garden/Beds/Tomato Bed.md')).toContain('[pepper row](Pepper%20Row.md)');
    expect(read('Logbook/2026-03-01.md')).toContain('[[Tomato Bed]]');
    // 'Beds/Tomato Bed' still matches the end of 'Garden/Beds/Tomato Bed.md', so those links stay.
    expect(read('Refs.md')).toBe(REFS);
    // Pepper Row's '../Media/photo.jpg' now starts from Garden/Beds and needs one more '../'.
    expect(read('Garden/Beds/Pepper Row.md')).toContain('![](../../Media/photo.jpg)');
    expect(r.links_updated).toEqual([{ path: 'Garden/Beds/Pepper Row.md', links: 1 }]);
  });

  it('renames a folder of attachments and fixes path links to them', async () => {
    const { ops } = full();
    const r = await ops.mover.moveFolder('Media', 'Pictures');
    expect(exists('Pictures/diagram.png') && exists('Pictures/Other/diagram.png')).toBe(true);
    expect(read('Beds/Tomato Bed.md')).toContain('![[diagram.png]]');
    expect(read('Beds/Pepper Row.md')).toContain('![](../Pictures/photo.jpg)');
    expect(r.links_updated).toEqual([{ path: 'Beds/Pepper Row.md', links: 1 }]);
  });

  it('refuses unsafe or overwriting folder moves', async () => {
    const { ops } = full({ READONLY_DIRS: 'Almanac,Logbook/Locked' });
    fs.mkdirSync(abs('Logbook/Locked'));
    const cases: [string, string, RegExp][] = [
      ['Beds', 'Beds/Sub', /into itself/],
      ['Beds', 'Beds', /into itself/],
      ['Beds', 'Logbook', /Already exists/],
      ['Beds', '', /required/],
      ['Beds', '.obsidian/Beds', /Dot-prefixed/],
      ['Beds', '.trash', /Dot-prefixed/],
      ['Beds', 'ConfigLink/Beds', /Dot-prefixed/],
      ['Beds', 'EscapeDir/Beds', /outside the vault/],
      ['Beds', '../outside/Beds', /Invalid path/],
      ['Beds', 'Almanac/Beds', /read-only/],
      ['Almanac', 'Reference', /read-only/],
      ['Logbook', 'Diary', /read-only/],
      ['.obsidian', 'Settings', /Dot-prefixed/],
      ['EscapeDir', 'Inside', /symlink/],
      ['ConfigLink', 'Inside', /symlink/],
      ['Lonely.md', 'Inside', /Not a folder/],
      ['Missing', 'Inside', /Not found/],
    ];
    for (const [p, dest, err] of cases) await expect(ops.mover.moveFolder(p, dest), `${p} -> ${dest}`).rejects.toThrow(err);
    expect(exists('Beds/Tomato Bed.md') && exists('Logbook/2026-03-01.md') && exists('Almanac/Frost Dates.md')).toBe(true);
    expect(fs.readdirSync(tv.outside).sort()).toEqual(['secret.md', 'secret.png']);
  });
});

describe('delete_note', () => {
  it("moves the note into .trash and never deletes it", async () => {
    const { ops } = full();
    const text = read('Lonely.md');
    const r = await ops.mover.deleteNote('Lonely.md');
    expect(r).toMatchObject({ path: 'Lonely.md', trashed_to: '.trash/Lonely.md' });
    expect(exists('Lonely.md')).toBe(false);
    expect(read('.trash/Lonely.md')).toBe(text);
  });

  it('keeps an existing trashed note with the same name', async () => {
    write('Logbook/Old Note.md', 'newer\n');
    const old = read('.trash/Old Note.md');
    const { ops } = full();
    const r = await ops.mover.deleteNote('Logbook/Old Note.md');
    expect(r.trashed_to).toBe('.trash/Old Note 2.md');
    expect(read('.trash/Old Note.md')).toBe(old);
    expect(read('.trash/Old Note 2.md')).toBe('newer\n');
  });

  it('creates .trash if the vault has none', async () => {
    fs.rmSync(abs('.trash'), { recursive: true });
    const { ops } = full();
    await ops.mover.deleteNote('Lonely.md');
    expect(exists('.trash/Lonely.md')).toBe(true);
  });

  it('refuses a .trash that is a symlink', async () => {
    fs.rmSync(abs('.trash'), { recursive: true });
    fs.symlinkSync(tv.outside, abs('.trash'));
    const { ops } = full();
    await expect(ops.mover.deleteNote('Lonely.md')).rejects.toThrow(/\.trash is not a plain folder/);
    expect(exists('Lonely.md')).toBe(true);
    expect(fs.readdirSync(tv.outside).sort()).toEqual(['secret.md', 'secret.png']);
  });

  it('refuses paths it must not touch', async () => {
    const { ops } = full();
    const cases: [string, RegExp][] = [
      ['.obsidian/app.json', /Dot-prefixed/],
      ['.trash/Old Note.md', /Dot-prefixed/],
      ['../outside/secret.md', /Invalid path/],
      ['Escape.md', /symlink/],
      ['config.md', /symlink/],
      ['Almanac/Frost Dates.md', /read-only/],
      ['Media/diagram.png', /Not a Markdown note/],
      ['Beds', /Not a Markdown note/],
      ['Missing.md', /Not found/],
    ];
    for (const [p, err] of cases) await expect(ops.mover.deleteNote(p), p).rejects.toThrow(err);
    expect(exists('Almanac/Frost Dates.md') && exists('.obsidian/app.json')).toBe(true);
    expect(fs.existsSync(path.join(tv.outside, 'secret.md'))).toBe(true);
  });
});

describe('snapshot before every change', () => {
  it('runs the script with "Before <tool> <path>" before each change', async () => {
    const snap = recordingScript();
    const { ops } = full({ SNAPSHOT_PATH: snap.script });
    expect((await ops.mover.renameNote('Seed Catalog.md', 'Seeds')).snapshot).toBe('taken');
    await ops.mover.moveNote('Compost Heap.md', 'Beds');
    await ops.mover.moveFolder('Logbook', 'Journal');
    await ops.mover.deleteNote('Lonely.md');
    expect(snap.entries()).toEqual([
      'Before rename_note Seed Catalog.md [present]',
      'Before move_note Compost Heap.md [present]',
      'Before move_folder Logbook [present]',
      // Taken while the note was still in place.
      'Before delete_note Lonely.md [present]',
    ]);
  });

  it('does not run the script for a refused change', async () => {
    const snap = recordingScript();
    const { ops } = full({ SNAPSHOT_PATH: snap.script });
    await expect(ops.mover.deleteNote('.obsidian/app.json')).rejects.toThrow();
    await expect(ops.mover.moveNote('Lonely.md', 'EscapeDir')).rejects.toThrow();
    await expect(ops.mover.renameNote('Beds/Tomato Bed.md', 'Pepper Row')).rejects.toThrow();
    await expect(ops.mover.moveFolder('Beds', 'Logbook')).rejects.toThrow();
    expect(snap.entries()).toEqual([]);
  });

  it('refuses the change if the script fails or cannot run', async () => {
    const failing = path.join(tv.base, 'failing-snapshot');
    fs.writeFileSync(failing, '#!/bin/sh\necho "git exploded" >&2\nexit 1\n', { mode: 0o755 });
    const { ops } = full({ SNAPSHOT_PATH: failing });
    await expect(ops.mover.deleteNote('Lonely.md')).rejects.toThrow(/snapshot script failed, so nothing was changed/);
    await expect(ops.mover.renameNote('Beds/Tomato Bed.md', 'X')).rejects.toThrow(/snapshot script failed/);
    expect(exists('Lonely.md') && exists('Beds/Tomato Bed.md')).toBe(true);
    expect(read('Logbook/2026-03-01.md')).toContain('[[Tomato Bed]]');

    const notExecutable = path.join(tv.base, 'plain-file');
    fs.writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const { ops: ops2 } = full({ SNAPSHOT_PATH: notExecutable });
    await expect(ops2.mover.moveFolder('Beds', 'Garden')).rejects.toThrow(/cannot be run/);
    expect(exists('Beds')).toBe(true);
  });

  it('goes ahead and says so when no script is installed', async () => {
    const { ops, logs } = full();
    const r = await ops.mover.deleteNote('Lonely.md');
    expect(r.snapshot).toMatch(/skipped/);
    expect(logs.some((l) => l.includes('"event":"snapshot"') && l.includes('script not installed'))).toBe(true);
  });
});

describe('retrying a change that already happened', () => {
  const ALREADY = /already moved to .* by an earlier call/;

  it('rename_note: a retry returns success with a note, and changes nothing', async () => {
    write('Refs.md', REFS);
    const snap = recordingScript();
    const { ops, logs } = full({ SNAPSHOT_PATH: snap.script });
    const first = await ops.mover.renameNote('Beds/Tomato Bed.md', 'Tomato Patch');
    const refs = read('Refs.md');
    const moves = logs.filter((l) => l.includes('"event":"move"')).length;
    const again = await ops.mover.renameNote('Beds/Tomato Bed.md', 'Tomato Patch.md');
    expect(again).toMatchObject({ ...first, already_done: true, note: expect.stringMatching(ALREADY) });
    expect(read('Refs.md')).toBe(refs);
    expect(snap.entries()).toHaveLength(1);
    expect(logs.filter((l) => l.includes('"event":"move"'))).toHaveLength(moves);
    expect(logs.some((l) => l.includes('"event":"timing"') && l.includes('"already_done":true'))).toBe(true);
  });

  it('move_note: a retry returns success with a note', async () => {
    const { ops } = full();
    const first = await ops.mover.moveNote('Beds/Pepper Row.md', 'Archive/2026');
    const again = await ops.mover.moveNote('Beds/Pepper Row.md', 'Archive/2026');
    expect(again).toMatchObject({ ...first, already_done: true, note: expect.stringMatching(ALREADY) });
    expect(exists('Archive/2026/Pepper Row.md')).toBe(true);
  });

  it('move_folder: a retry returns success with a note', async () => {
    const { ops } = full();
    const first = await ops.mover.moveFolder('Beds', 'Garden/Beds');
    const again = await ops.mover.moveFolder('Beds', 'Garden/Beds');
    expect(again).toMatchObject({ ...first, already_done: true, note: expect.stringMatching(ALREADY) });
    expect(exists('Garden/Beds/Tomato Bed.md') && !exists('Beds')).toBe(true);
  });

  it('two identical calls at once: one moves, the other reports it already done', async () => {
    const snap = recordingScript();
    const { ops } = full({ SNAPSHOT_PATH: snap.script });
    const [a, b] = await Promise.all([
      ops.mover.renameNote('Lonely.md', 'Alone'),
      ops.mover.renameNote('Lonely.md', 'Alone'),
    ]);
    expect([a, b].filter((r) => 'already_done' in r)).toHaveLength(1);
    expect(exists('Alone.md') && !exists('Lonely.md')).toBe(true);
    expect(snap.entries()).toHaveLength(1);
  });

  it('refuses a retry when the moved note has changed since', async () => {
    const { ops } = full();
    await ops.mover.renameNote('Lonely.md', 'Alone');
    write('Alone.md', 'edited after the move\n');
    await expect(ops.mover.renameNote('Lonely.md', 'Alone')).rejects.toThrow(/Not found: Lonely.md/);
    expect(read('Alone.md')).toBe('edited after the move\n');
  });

  it('refuses a folder retry when a file in it has changed or been added', async () => {
    const { ops } = full();
    await ops.mover.moveFolder('Beds', 'Garden');
    write('Garden/New.md', 'new\n');
    await expect(ops.mover.moveFolder('Beds', 'Garden')).rejects.toThrow(/Not found: Beds/);
  });

  it('refuses when the source is gone and the target is missing or was never moved there by this server', async () => {
    const { ops } = full();
    await ops.mover.renameNote('Lonely.md', 'Alone');
    fs.renameSync(abs('Alone.md'), abs('Elsewhere.md'));
    await expect(ops.mover.renameNote('Lonely.md', 'Alone')).rejects.toThrow(/Not found: Lonely.md/);
    // Seed Catalog was never renamed by this server, even though the target holds the same text.
    write('Copy.md', read('Seed Catalog.md'));
    fs.rmSync(abs('Seed Catalog.md'));
    await expect(ops.mover.renameNote('Seed Catalog.md', 'Copy')).rejects.toThrow(/Not found: Seed Catalog.md/);
  });

  it('a retry with a different destination is not treated as done', async () => {
    const { ops } = full();
    await ops.mover.renameNote('Lonely.md', 'Alone');
    await expect(ops.mover.renameNote('Lonely.md', 'Solo')).rejects.toThrow(/Not found: Lonely.md/);
    expect(exists('Solo.md')).toBe(false);
  });
});

describe('timing log', () => {
  it('logs how long each step of a move took', async () => {
    const { ops, logs } = full();
    await ops.mover.renameNote('Beds/Tomato Bed.md', 'Tomato Patch');
    const line = logs.map((l) => JSON.parse(l)).find((l) => l.event === 'timing');
    expect(line).toMatchObject({ tool: 'rename_note', from: 'Beds/Tomato Bed.md', to: 'Beds/Tomato Patch.md', notes_to_fix: 2 });
    expect(Object.keys(line.ms)).toEqual(['walk', 'plan', 'snapshot', 'move', 'links', 'record', 'total']);
  });
});

describe('retrying a folder move with attachments', () => {
  it('recognises the retry, and still refuses it when an attachment changed', async () => {
    const { ops } = full();
    await ops.mover.moveFolder('Media', 'Pictures');
    expect(await ops.mover.moveFolder('Media', 'Pictures')).toMatchObject({ already_done: true });
    fs.appendFileSync(abs('Pictures/photo.jpg'), 'more bytes');
    await expect(ops.mover.moveFolder('Media', 'Pictures')).rejects.toThrow(/Not found: Media/);
  });
});
