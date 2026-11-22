import fs from 'node:fs';
import path from 'node:path';
import moment from 'moment';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDailySettings } from '../src/daily.js';
import { makeOps, makeVault, type TestVault } from './helpers.js';

let tv: TestVault;
beforeEach(() => {
  tv = makeVault();
});
afterEach(() => fs.rmSync(tv.base, { recursive: true, force: true }));

const settingsFile = () => path.join(tv.dir, '.obsidian', 'daily-notes.json');

describe('daily note settings', () => {
  it('reads folder, format and template from daily-notes.json', async () => {
    const s = await loadDailySettings(tv.dir, { dailyDir: 'Elsewhere', dailyFormat: 'DD-MM-YYYY', dailyTemplate: 'Other' });
    expect(s).toEqual({ folder: 'Logbook', format: 'YYYY-MM-DD', template: 'Blueprints/Daily Blueprint.md', source: 'daily-notes.json' });
  });

  it('falls back to env per field when the file omits it', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ folder: 'Logbook' }));
    const s = await loadDailySettings(tv.dir, { dailyDir: 'Elsewhere', dailyFormat: 'YYYY/MM/DD', dailyTemplate: 'Blueprints/Daily Blueprint' });
    expect(s).toMatchObject({ folder: 'Logbook', format: 'YYYY/MM/DD', template: 'Blueprints/Daily Blueprint.md' });
  });

  it('uses env when the file is missing, then Obsidian defaults', async () => {
    fs.rmSync(settingsFile());
    expect(await loadDailySettings(tv.dir, { dailyDir: 'Journal2', dailyFormat: undefined, dailyTemplate: undefined })).toEqual({
      folder: 'Journal2',
      format: 'YYYY-MM-DD',
      template: null,
      source: 'env',
    });
    expect(await loadDailySettings(tv.dir, { dailyDir: undefined, dailyFormat: undefined, dailyTemplate: undefined })).toEqual({
      folder: '',
      format: 'YYYY-MM-DD',
      template: null,
      source: 'default',
    });
  });

  it('ignores a corrupt settings file', async () => {
    fs.writeFileSync(settingsFile(), '{not json');
    const s = await loadDailySettings(tv.dir, { dailyDir: 'Journal2', dailyFormat: undefined, dailyTemplate: undefined });
    expect(s.source).toBe('env');
  });

  it('refuses a settings folder that escapes the vault', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ folder: '../outside' }));
    await expect(loadDailySettings(tv.dir, { dailyDir: undefined, dailyFormat: undefined, dailyTemplate: undefined })).rejects.toThrow();
  });
});

describe('get_daily_note', () => {
  it('returns an existing note without changing it', async () => {
    const { ops, logs } = makeOps(tv.dir);
    const r = (await ops.getDailyNote('2026-03-01', true)) as any;
    expect(r).toMatchObject({ path: 'Logbook/2026-03-01.md', created: false });
    expect(r.content).toContain('Watered');
    expect(logs).toEqual([]);
  });

  it('creates a missing note from the template in write mode', async () => {
    const { ops } = makeOps(tv.dir);
    const r = (await ops.getDailyNote('2026-03-02', true)) as any;
    expect(r).toMatchObject({ path: 'Logbook/2026-03-02.md', created: true });
    const text = fs.readFileSync(path.join(tv.dir, 'Logbook', '2026-03-02.md'), 'utf8');
    expect(text).toContain('# Monday, March 2');
    expect(text).toContain('Title: 2026-03-02');
    expect(text).toContain('Date: 2026-03-02');
  });

  it("defaults to today's date", async () => {
    const { ops } = makeOps(tv.dir);
    const r = (await ops.getDailyNote(undefined, false)) as any;
    expect(r.path).toBe(`Logbook/${moment().format('YYYY-MM-DD')}.md`);
  });

  it('never creates twice, even when called at the same time', async () => {
    const { ops, logs } = makeOps(tv.dir);
    const results = (await Promise.all(Array.from({ length: 5 }, () => ops.getDailyNote('2026-03-05', true)))) as any[];
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(logs).toHaveLength(1);
    const again = (await ops.getDailyNote('2026-03-05', true)) as any;
    expect(again.created).toBe(false);
  });

  it('never creates in read mode', async () => {
    const { ops } = makeOps(tv.dir, { ACCESS_MODE: 'read' });
    const r = (await ops.getDailyNote('2026-03-02', true)) as any;
    expect(r).toMatchObject({ exists: false, created: false });
    expect(fs.existsSync(path.join(tv.dir, 'Logbook', '2026-03-02.md'))).toBe(false);
  });

  it('does not create when create_if_missing is false', async () => {
    const { ops } = makeOps(tv.dir);
    const r = (await ops.getDailyNote('2026-03-02', false)) as any;
    expect(r.exists).toBe(false);
  });

  it('rejects bad dates', async () => {
    const { ops } = makeOps(tv.dir);
    await expect(ops.getDailyNote('03/02/2026', true)).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('read_daily_notes returns existing notes in a range', async () => {
    const { ops } = makeOps(tv.dir);
    const r = await ops.readDailyNotes('2026-02-28', '2026-03-04');
    expect(r.notes.map((n) => n.date)).toEqual(['2026-03-01', '2026-03-03']);
    await expect(ops.readDailyNotes('2026-03-04', '2026-03-01')).rejects.toThrow(/before/);
  });
});
