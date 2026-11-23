import moment from 'moment';
import picomatch from 'picomatch';
import { parseDocument, isMap } from 'yaml';
import type { Config } from './config.js';
import { dailyNotePath, loadDailySettings, parseIsoDate, renderTemplate } from './daily.js';
import { findSection, normaliseTag, splitFrontmatter } from './markdown.js';
import { checkRelFolder, checkRelPath, isInside, VaultError } from './paths.js';
import { Mover } from './mover.js';
import { LinkResolver, sha256, type LoadedNote, type Vault, type VaultFile } from './vault.js';
import type { Writer } from './writer.js';

const iso = (ms: number) => new Date(ms).toISOString();
const clampLimit = (n: number | undefined, def: number, max: number) => Math.max(1, Math.min(n ?? def, max));

function parseDateArg(value: string, name: string): number {
  const m = moment(value.trim(), ['YYYY-MM-DD', moment.ISO_8601], true);
  if (!m.isValid()) throw new VaultError(`${name} must be a date like 2026-01-31 or an ISO time`);
  return m.valueOf();
}

export class Ops {
  readonly mover: Mover;

  constructor(
    readonly vault: Vault,
    readonly writer: Writer,
    readonly cfg: Config,
    log?: (line: string) => void,
  ) {
    this.mover = new Mover(vault, writer, cfg, log);
  }

  // ---------- reading ----------

  async readNote(pathArg: string, part: 'full' | 'body' | 'frontmatter' | 'outline' | 'section', heading?: string) {
    const note = await this.vault.loadNote(pathArg);
    const base = { path: note.file.rel, hash: note.hash, modified: iso(note.file.mtimeMs) };
    const p = note.parsed;
    const fm = { frontmatter: p.frontmatter, ...(p.frontmatterError ? { frontmatter_error: p.frontmatterError } : {}) };
    switch (part) {
      case 'full':
        return { ...base, ...fm, content: note.text };
      case 'body':
        return { ...base, body: p.body };
      case 'frontmatter':
        return { ...base, ...fm };
      case 'outline':
        return { ...base, headings: p.headings };
      case 'section': {
        if (!heading) throw new VaultError("part 'section' needs a heading");
        const s = findSection(p.body, heading);
        if (!s) throw new VaultError(`Heading not found in ${note.file.rel}: ${heading}`);
        return { ...base, heading, section: p.body.slice(s.start, s.end).replace(/\s+$/, '') };
      }
    }
  }

  private filterFolder(files: VaultFile[], folder?: string): VaultFile[] {
    const f = checkRelFolder(folder);
    return files.filter((x) => isInside(f, x.rel));
  }

  async listNotes(folder?: string, glob?: string, limit?: number) {
    let files = this.filterFolder(await this.vault.listNotes(), folder);
    if (glob) {
      const isMatch = picomatch(glob, { dot: false, nocase: true });
      files = files.filter((f) => isMatch(f.rel) || isMatch(f.rel.split('/').pop()!));
    }
    const max = clampLimit(limit, 200, 2000);
    return {
      total: files.length,
      truncated: files.length > max,
      notes: files.slice(0, max).map((f) => ({ path: f.rel, modified: iso(f.mtimeMs), size: f.size })),
    };
  }

  async recentNotes(since: string, field: 'modified' | 'created', folder?: string, limit?: number) {
    const t = parseDateArg(since, 'since');
    const key = field === 'created' ? 'birthtimeMs' : 'mtimeMs';
    const files = this.filterFolder(await this.vault.listNotes(), folder)
      .filter((f) => f[key] >= t)
      .sort((a, b) => b[key] - a[key]);
    const max = clampLimit(limit, 50, 1000);
    return {
      total: files.length,
      truncated: files.length > max,
      notes: files.slice(0, max).map((f) => ({ path: f.rel, modified: iso(f.mtimeMs), created: iso(f.birthtimeMs) })),
    };
  }

  async staleNotes(before: string, folder?: string, limit?: number) {
    const t = parseDateArg(before, 'before');
    const files = this.filterFolder(await this.vault.listNotes(), folder)
      .filter((f) => f.mtimeMs < t)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    const max = clampLimit(limit, 50, 1000);
    return {
      total: files.length,
      truncated: files.length > max,
      notes: files.slice(0, max).map((f) => ({ path: f.rel, modified: iso(f.mtimeMs) })),
    };
  }

  private async notesIn(folder?: string): Promise<LoadedNote[]> {
    const f = checkRelFolder(folder);
    return (await this.vault.loadAllNotes()).filter((n) => isInside(f, n.file.rel));
  }

  async listTags(folder?: string) {
    const counts = new Map<string, number>();
    for (const n of await this.notesIn(folder)) for (const t of n.parsed.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return { tags: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, notes]) => ({ tag, notes })) };
  }

  async searchByTag(tag: string, includeNested: boolean, folder?: string, limit?: number) {
    const want = normaliseTag(tag);
    if (!want) throw new VaultError('tag is required');
    const matches = (await this.notesIn(folder))
      .map((n) => ({ n, hit: n.parsed.tags.filter((t) => t === want || (includeNested && t.startsWith(want + '/'))) }))
      .filter((x) => x.hit.length > 0);
    const max = clampLimit(limit, 100, 2000);
    return {
      total: matches.length,
      truncated: matches.length > max,
      notes: matches.slice(0, max).map((x) => ({ path: x.n.file.rel, matched_tags: x.hit })),
    };
  }

  async listPropertyKeys(folder?: string) {
    const counts = new Map<string, number>();
    for (const n of await this.notesIn(folder)) for (const k of Object.keys(n.parsed.frontmatter ?? {})) counts.set(k, (counts.get(k) ?? 0) + 1);
    return { keys: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, notes]) => ({ key, notes })) };
  }

  async listPropertyValues(key: string, folder?: string, limit?: number) {
    const counts = new Map<string, number>();
    for (const n of await this.notesIn(folder)) {
      const fm = n.parsed.frontmatter;
      if (!fm || !(key in fm)) continue;
      for (const v of valuesOf(fm[key])) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const max = clampLimit(limit, 200, 2000);
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { key, truncated: sorted.length > max, values: sorted.slice(0, max).map(([value, notes]) => ({ value, notes })) };
  }

  async searchByProperty(key: string, value: string | undefined, folder?: string, limit?: number) {
    const want = value?.trim().toLowerCase();
    const matches = (await this.notesIn(folder)).filter((n) => {
      const fm = n.parsed.frontmatter;
      if (!fm || !(key in fm)) return false;
      if (want === undefined) return true;
      return valuesOf(fm[key]).some((v) => v.toLowerCase() === want);
    });
    const max = clampLimit(limit, 100, 2000);
    return {
      total: matches.length,
      truncated: matches.length > max,
      notes: matches.slice(0, max).map((n) => ({ path: n.file.rel, value: n.parsed.frontmatter![key] ?? null })),
    };
  }

  // ---------- links ----------

  private async linkGraph() {
    const files = await this.vault.listFiles();
    const resolver = new LinkResolver(files.map((f) => f.rel));
    const notes = await this.vault.loadAllNotes();
    return { resolver, notes, files };
  }

  async outgoingLinks(pathArg: string) {
    const note = await this.vault.loadNote(pathArg);
    const resolver = new LinkResolver((await this.vault.listFiles()).map((f) => f.rel));
    return {
      path: note.file.rel,
      links: note.parsed.links.map((l) => ({
        target: l.target || null,
        fragment: l.fragment,
        kind: l.kind,
        embed: l.embed,
        line: l.line,
        resolved: l.target ? resolver.resolve(l.target, note.file.rel) : note.file.rel,
      })),
    };
  }

  async backlinks(pathArg: string, limit?: number) {
    const target = await this.vault.statFile(pathArg);
    const { resolver, notes } = await this.linkGraph();
    const out: { path: string; line: number; kind: string }[] = [];
    for (const n of notes) {
      if (n.file.rel === target.rel) continue;
      for (const l of n.parsed.links) {
        if (l.target && resolver.resolve(l.target, n.file.rel) === target.rel) out.push({ path: n.file.rel, line: l.line, kind: l.kind });
      }
    }
    const max = clampLimit(limit, 200, 2000);
    return { path: target.rel, total: out.length, truncated: out.length > max, backlinks: out.slice(0, max) };
  }

  /** Notes that no other note links to. */
  async orphans(folder?: string, limit?: number) {
    const { resolver, notes } = await this.linkGraph();
    const linked = new Set<string>();
    for (const n of notes) {
      for (const l of n.parsed.links) {
        if (!l.target) continue;
        const r = resolver.resolve(l.target, n.file.rel);
        if (r && r !== n.file.rel) linked.add(r);
      }
    }
    const f = checkRelFolder(folder);
    const orphans = notes.filter((n) => isInside(f, n.file.rel) && !linked.has(n.file.rel)).map((n) => n.file.rel);
    const max = clampLimit(limit, 200, 2000);
    return { total: orphans.length, truncated: orphans.length > max, notes: orphans.slice(0, max) };
  }

  // ---------- daily notes ----------

  async getDailyNote(date: string | undefined, createIfMissing: boolean) {
    const s = await loadDailySettings(this.vault.root, this.cfg);
    let d;
    try {
      d = parseIsoDate(date);
    } catch (e) {
      throw new VaultError((e as Error).message);
    }
    const rel = dailyNotePath(s, d);
    checkRelPath(rel);
    // Always look for an existing note first.
    try {
      const note = await this.vault.loadNote(rel);
      return { path: rel, created: false, hash: note.hash, content: note.text, settings_source: s.source };
    } catch (e) {
      if (!(e instanceof VaultError) || !e.message.startsWith('Not found')) throw e;
    }
    if (!createIfMissing || this.cfg.accessMode === 'read') {
      return { path: rel, exists: false, created: false, settings_source: s.source };
    }
    let content = '';
    if (s.template) {
      try {
        const tpl = await this.vault.loadNote(s.template);
        content = renderTemplate(tpl.text, d.format(s.format).split('/').pop()!, d, moment(), s.format);
      } catch (e) {
        throw new VaultError(`Daily note template could not be read (${s.template}): ${(e as Error).message}`);
      }
    }
    const target = await this.writer.vaultPaths.resolveForWrite(rel);
    const result = await this.writer.withLock(target.rel, async () => {
      if (target.exists) return null;
      try {
        return await this.writer.create('get_daily_note', target.rel, target.abs, content);
      } catch (e) {
        // Another call created it first. Return that note instead; never overwrite.
        if (e instanceof VaultError && e.message.startsWith('Note already exists')) return null;
        throw e;
      }
    });
    if (!result) {
      const note = await this.vault.loadNote(rel);
      return { path: rel, created: false, hash: note.hash, content: note.text, settings_source: s.source };
    }
    return { path: rel, created: true, hash: result.hash, content, settings_source: s.source };
  }

  async readDailyNotes(start: string, end: string, limit?: number) {
    const s = await loadDailySettings(this.vault.root, this.cfg);
    let a, b;
    try {
      a = parseIsoDate(start);
      b = parseIsoDate(end);
    } catch (e) {
      throw new VaultError((e as Error).message);
    }
    if (b.isBefore(a)) throw new VaultError('end is before start');
    const max = clampLimit(limit, 31, 366);
    const notes: { date: string; path: string; content: string }[] = [];
    let truncated = false;
    for (const d = a.clone(); !d.isAfter(b); d.add(1, 'day')) {
      const rel = dailyNotePath(s, d);
      try {
        const n = await this.vault.loadNote(rel);
        if (notes.length >= max) {
          truncated = true;
          break;
        }
        notes.push({ date: d.format('YYYY-MM-DD'), path: rel, content: n.text });
      } catch {
        /* no note that day */
      }
    }
    return { start: a.format('YYYY-MM-DD'), end: b.format('YYYY-MM-DD'), found: notes.length, truncated, notes };
  }

  // ---------- writing ----------

  async createNote(args: { path?: string; title?: string; content: string; properties?: Record<string, unknown> }) {
    let rel: string;
    if (args.path) {
      rel = args.path;
    } else if (args.title) {
      const title = args.title.trim();
      if (!title || /[*"\\/<>:|?#^[\]]/.test(title) || title.startsWith('.')) {
        throw new VaultError('title contains characters Obsidian does not allow in file names');
      }
      rel = this.cfg.inboxDir ? `${this.cfg.inboxDir}/${title}` : title;
    } else {
      throw new VaultError('Give a path or a title');
    }
    if (!rel.toLowerCase().endsWith('.md')) rel += '.md';
    let content = args.content;
    if (args.properties && Object.keys(args.properties).length > 0) {
      if (splitFrontmatter(content).raw !== null) throw new VaultError('content already has frontmatter; pass properties inside it or not at all');
      const doc = parseDocument('{}');
      doc.contents = doc.createNode(args.properties) as unknown as typeof doc.contents;
      content = `---\n${doc.toString().trimEnd()}\n---\n${content}`;
    }
    const target = await this.writer.vaultPaths.resolveForWrite(rel);
    if (target.exists) throw new VaultError(`Note already exists: ${target.rel}`);
    const r = await this.writer.withLock(target.rel, () => this.writer.create('create_note', target.rel, target.abs, content));
    return { path: target.rel, bytes: r.bytes, hash: r.hash };
  }

  /** Read-modify-write under the file lock, with an optional stale-content check. */
  private async modify(tool: string, pathArg: string, expectedHash: string | undefined, fn: (text: string, rel: string) => string) {
    const target = await this.writer.vaultPaths.resolveForWrite(pathArg);
    if (!target.exists) throw new VaultError(`Not found: ${target.rel}`);
    return this.writer.withLock(target.rel, async () => {
      const note = await this.vault.loadNote(target.rel);
      if (expectedHash !== undefined && expectedHash !== note.hash) {
        throw new VaultError(`Note changed since it was read (hash mismatch): ${target.rel}. Read it again and retry.`);
      }
      const next = fn(note.text, target.rel);
      const r = await this.writer.replace(tool, target.rel, target.abs, next);
      return { path: target.rel, bytes: r.bytes, hash: r.hash };
    });
  }

  async appendToNote(pathArg: string, content: string, heading?: string) {
    return this.modify('append_to_note', pathArg, undefined, (text, rel) => {
      const add = content.endsWith('\n') ? content : content + '\n';
      if (!heading) return text === '' || text.endsWith('\n') ? text + add : text + '\n' + add;
      const { raw, body } = splitFrontmatter(text);
      const prefix = raw === null ? '' : text.slice(0, text.length - body.length);
      const s = findSection(body, heading);
      if (!s) throw new VaultError(`Heading not found in ${rel}: ${heading}`);
      // Insert after the section's last non-blank line, keeping blank lines before the next heading.
      const trimmed = body.slice(s.contentStart, s.end).replace(/\s+$/, '');
      const sectionEnd = s.contentStart + trimmed.length;
      const before = body.slice(0, sectionEnd);
      const after = body.slice(sectionEnd);
      const joiner = before.endsWith('\n') || before === '' ? '' : '\n';
      const tail = after === '' ? '' : after.startsWith('\n') ? after : '\n' + after;
      return prefix + before + joiner + add.replace(/\n$/, '') + (tail === '' ? '\n' : tail);
    });
  }

  async replaceInNote(pathArg: string, oldText: string, newText: string, expectedHash: string) {
    if (oldText === '') throw new VaultError('old_text must not be empty');
    return this.modify('replace_in_note', pathArg, expectedHash, (text, rel) => {
      const first = text.indexOf(oldText);
      if (first < 0) throw new VaultError(`old_text not found in ${rel}`);
      if (text.indexOf(oldText, first + 1) >= 0) throw new VaultError(`old_text matches more than once in ${rel}; include more surrounding text`);
      return text.slice(0, first) + newText + text.slice(first + oldText.length);
    });
  }

  async updateProperties(pathArg: string, set: Record<string, unknown> | undefined, unset: string[] | undefined, expectedHash?: string) {
    if ((!set || Object.keys(set).length === 0) && (!unset || unset.length === 0)) throw new VaultError('Nothing to change: give set and/or unset');
    return this.modify('update_properties', pathArg, expectedHash, (text, rel) => {
      const { raw, body } = splitFrontmatter(text);
      const doc = parseDocument(raw ?? '');
      if (doc.errors.length > 0) throw new VaultError(`Frontmatter in ${rel} is malformed; fix it by hand first (${doc.errors[0]!.message.split('\n')[0]})`);
      if (doc.contents !== null && !isMap(doc.contents)) throw new VaultError(`Frontmatter in ${rel} is not a key/value map`);
      if (doc.contents === null) doc.contents = doc.createNode({}) as unknown as typeof doc.contents;
      for (const [k, v] of Object.entries(set ?? {})) doc.set(k, v);
      for (const k of unset ?? []) doc.delete(k);
      const yamlText = isMap(doc.contents) && doc.contents.items.length === 0 && !doc.commentBefore && !doc.comment ? '' : doc.toString().trimEnd();
      if (yamlText === '' || yamlText === '{}') return raw === null ? body : `---\n---\n${body}`;
      return `---\n${yamlText}\n---\n${body}`;
    });
  }
}

/** Flatten a property value into comparable strings (lists give one value per item). */
function valuesOf(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap(valuesOf);
  if (v instanceof Date) return [v.toISOString().slice(0, 10)];
  if (typeof v === 'object') return [JSON.stringify(v)];
  return [String(v)];
}

export { sha256 };
