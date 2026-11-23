import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseNote, type ParsedNote } from './markdown.js';
import { VaultError, VaultPaths } from './paths.js';

export interface VaultFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  isNote: boolean;
}

export interface LoadedNote {
  file: VaultFile;
  text: string;
  hash: string;
  parsed: ParsedNote;
}

export function sha256(text: string | Buffer): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export const isNotePath = (rel: string) => rel.toLowerCase().endsWith('.md');

export class Vault {
  private cache = new Map<string, { mtimeMs: number; size: number; note: LoadedNote }>();

  constructor(
    readonly paths: VaultPaths,
    private readonly readMaxBytes: number,
  ) {}

  get root() {
    return this.paths.root;
  }

  /**
   * Every non-hidden file in the vault. Skips dot-prefixed entries everywhere.
   * Symlinked files are included only if they resolve inside the vault; symlinked folders are skipped (avoids loops).
   */
  async listFiles(): Promise<VaultFile[]> {
    const out: VaultFile[] = [];
    const walk = async (absDir: string, relDir: string) => {
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        const abs = path.join(absDir, e.name);
        if (e.isDirectory()) {
          await walk(abs, rel);
          continue;
        }
        let realAbs = abs;
        if (e.isSymbolicLink()) {
          try {
            realAbs = await fs.realpath(abs);
          } catch {
            continue;
          }
          const realRel = this.paths.relOf(realAbs);
          if (realRel === null || realRel.split('/').some((p) => p.startsWith('.'))) continue;
        } else if (!e.isFile()) {
          continue;
        }
        try {
          const st = await fs.stat(realAbs);
          if (!st.isFile()) continue;
          out.push({
            rel,
            abs: realAbs,
            size: st.size,
            mtimeMs: st.mtimeMs,
            birthtimeMs: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs,
            isNote: isNotePath(rel),
          });
        } catch {
          /* vanished */
        }
      }
    };
    await walk(this.root, '');
    out.sort((a, b) => a.rel.localeCompare(b.rel));
    return out;
  }

  async listNotes(): Promise<VaultFile[]> {
    return (await this.listFiles()).filter((f) => f.isNote);
  }

  async statFile(rel: string): Promise<VaultFile> {
    const { rel: r, abs } = await this.paths.resolveExisting(rel);
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new VaultError(`Not a file: ${r}`);
    return {
      rel: r,
      abs,
      size: st.size,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs,
      isNote: isNotePath(r),
    };
  }

  /** Load and parse a note, using a cache keyed on mtime and size. */
  async loadNote(relOrFile: string | VaultFile): Promise<LoadedNote> {
    const file = typeof relOrFile === 'string' ? await this.statFile(relOrFile) : relOrFile;
    if (!file.isNote) throw new VaultError(`Not a Markdown note: ${file.rel}`);
    if (file.size > this.readMaxBytes) {
      throw new VaultError(`Note is larger than READ_MAX_BYTES (${file.size} > ${this.readMaxBytes}): ${file.rel}`);
    }
    const hit = this.cache.get(file.rel);
    if (hit && hit.mtimeMs === file.mtimeMs && hit.size === file.size) return hit.note;
    const text = await fs.readFile(file.abs, 'utf8');
    const note: LoadedNote = { file, text, hash: sha256(text), parsed: parseNote(text) };
    this.cache.set(file.rel, { mtimeMs: file.mtimeMs, size: file.size, note });
    return note;
  }

  /** Load every note that fits the read limit; notes over the limit are skipped. */
  async loadAllNotes(): Promise<LoadedNote[]> {
    const out: LoadedNote[] = [];
    for (const f of await this.listNotes()) {
      if (f.size > this.readMaxBytes) continue;
      try {
        out.push(await this.loadNote(f));
      } catch {
        /* unreadable; skip */
      }
    }
    return out;
  }
}

/**
 * Resolves link targets the way Obsidian does: relative to the source note, then from the vault root,
 * then by the shortest path whose end matches the target. Matching is case-insensitive.
 */
export class LinkResolver {
  private byLower = new Map<string, string>();
  /** Lowercased file name -> [lowercased path, path]. A suffix match always ends in the same file name. */
  private byName = new Map<string, [string, string][]>();

  constructor(files: string[]) {
    for (const f of files) {
      const fl = f.toLowerCase();
      this.byLower.set(fl, f);
      const name = fl.slice(fl.lastIndexOf('/') + 1);
      const bucket = this.byName.get(name);
      if (bucket) bucket.push([fl, f]);
      else this.byName.set(name, [[fl, f]]);
    }
  }

  resolve(target: string, sourceRel: string | null): string | null {
    let t = target.trim().replace(/\\/g, '/');
    if (t === '') return null;
    const candidates = (p: string) => (isNotePath(p) || /\.[a-z0-9]+$/i.test(p) ? [p, `${p}.md`] : [`${p}.md`, p]);

    if (t.startsWith('/')) t = t.replace(/^\/+/, '');
    else if (sourceRel !== null) {
      const dir = path.posix.dirname(sourceRel);
      const rel = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, t));
      if (!rel.startsWith('..')) {
        for (const c of candidates(rel)) {
          const hit = this.byLower.get(c.toLowerCase());
          if (hit) return hit;
        }
      }
    }
    const norm = path.posix.normalize(t);
    if (norm.startsWith('..')) return null;
    for (const c of candidates(norm)) {
      const hit = this.byLower.get(c.toLowerCase());
      if (hit) return hit;
    }
    // Shortest path whose trailing segments match.
    let best: string | null = null;
    for (const c of candidates(norm)) {
      const cl = c.toLowerCase();
      const suffix = '/' + cl;
      for (const [fl, f] of this.byName.get(cl.slice(cl.lastIndexOf('/') + 1)) ?? []) {
        if (fl.endsWith(suffix) || fl === cl) {
          if (best === null || f.length < best.length || (f.length === best.length && f < best)) best = f;
        }
      }
      if (best) return best;
    }
    return null;
  }
}
