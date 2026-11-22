import fs from 'node:fs/promises';
import path from 'node:path';
import moment from 'moment';
import type { Config } from './config.js';
import { normaliseRelDir } from './config.js';

export interface DailySettings {
  folder: string; // vault-relative, '' = root
  format: string; // Moment.js format
  template: string | null; // vault-relative path to the template note, or null
  source: 'daily-notes.json' | 'env' | 'default';
}

const DEFAULT_FORMAT = 'YYYY-MM-DD';

/**
 * Read the Daily Notes core plugin settings from <vault>/.obsidian/daily-notes.json.
 * This is the one place the server reads inside a dot folder. It is never exposed as a tool.
 * Fields used: `folder`, `format`, `template` (Obsidian omits fields left at their defaults).
 * Missing or empty fields fall back to DAILY_DIR, DAILY_FORMAT, DAILY_TEMPLATE, then Obsidian's defaults.
 */
export async function loadDailySettings(vaultDir: string, cfg: Pick<Config, 'dailyDir' | 'dailyFormat' | 'dailyTemplate'>): Promise<DailySettings> {
  let json: Record<string, unknown> | null = null;
  try {
    const raw = await fs.readFile(path.join(vaultDir, '.obsidian', 'daily-notes.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

  const folderRaw = str(json?.folder) ?? cfg.dailyDir;
  const format = str(json?.format) ?? cfg.dailyFormat ?? DEFAULT_FORMAT;
  const templateRaw = str(json?.template) ?? cfg.dailyTemplate;
  const usedJson = json !== null && (str(json.folder) || str(json.format) || str(json.template));
  const usedEnv = cfg.dailyDir !== undefined || cfg.dailyFormat !== undefined || cfg.dailyTemplate !== undefined;

  let template: string | null = null;
  if (templateRaw) {
    const t = templateRaw.replace(/^\/+/, '');
    template = t.toLowerCase().endsWith('.md') ? t : `${t}.md`;
  }
  return {
    folder: folderRaw ? normaliseRelDir(folderRaw, 'daily notes folder') : '',
    format,
    template,
    source: usedJson ? 'daily-notes.json' : usedEnv ? 'env' : 'default',
  };
}

export function parseIsoDate(value: string | undefined, now: Date = new Date()): moment.Moment {
  if (value === undefined || value.trim() === '' || value.trim().toLowerCase() === 'today') return moment(now).startOf('day');
  const m = moment(value.trim(), 'YYYY-MM-DD', true);
  if (!m.isValid()) throw new Error(`Dates must be YYYY-MM-DD (got '${value}')`);
  return m;
}

export function dailyNotePath(s: DailySettings, date: moment.Moment): string {
  const name = date.format(s.format);
  return (s.folder ? `${s.folder}/${name}` : name) + '.md';
}

/** Fill Obsidian core template variables: {{date}}, {{time}}, {{title}}, {{date:FMT}}, {{time:FMT}}. */
export function renderTemplate(template: string, title: string, date: moment.Moment, now: moment.Moment, dateFormat: string): string {
  return template.replace(/\{\{\s*(date|time|title)\s*(?::([^}]*))?\}\}/gi, (_all, kind: string, fmt: string | undefined) => {
    const k = kind.toLowerCase();
    if (k === 'title') return title;
    if (k === 'date') return date.format(fmt?.trim() || dateFormat);
    return now.format(fmt?.trim() || 'HH:mm');
  });
}
