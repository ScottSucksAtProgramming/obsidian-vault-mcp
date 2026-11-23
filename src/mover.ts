import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { parseNote, type RawLink } from './markdown.js';
import { checkName, checkRelFolder, checkRelPath, isInside, VaultError } from './paths.js';
import { isNotePath, LinkResolver, sha256, type Vault, type VaultFile } from './vault.js';
import type { Writer } from './writer.js';

const SNAPSHOT_TIMEOUT_MS = 120_000;
const STRUCTURE_LOCK = '\0structure';
/** How many finished moves to remember for retries. */
const DONE_MAX = 200;

interface LinkReport {
  links_updated: { path: string; links: number }[];
  links_not_updated: { path: string; reason: string }[];
}

/**
 * Full-mode changes: move, rename, move a folder, and delete to the vault's .trash folder.
 * Every change runs the snapshot script first (if installed), never overwrites anything,
 * and only one runs at a time.
 */
export class Mover {
  constructor(
    private readonly vault: Vault,
    private readonly writer: Writer,
    private readonly cfg: Config,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  private done = new Map<string, { print: string; result: object }>();

  private get paths() {
    return this.writer.vaultPaths;
  }

  async moveNote(pathArg: string, folderArg: string) {
    const srcRel = checkNotePath(pathArg);
    const folder = checkRelFolder(folderArg);
    const destRel = folder ? `${folder}/${path.posix.basename(srcRel)}` : path.posix.basename(srcRel);
    if (destRel === srcRel) throw new VaultError(`Note is already in that folder: ${srcRel}`);
    return this.relocate('move_note', srcRel, destRel, 'note');
  }

  async renameNote(pathArg: string, newName: string) {
    const srcRel = checkNotePath(pathArg);
    const name = checkName(newName.replace(/\.md$/i, ''));
    const dir = path.posix.dirname(srcRel);
    const destRel = `${dir === '.' ? '' : dir + '/'}${name}.md`;
    if (destRel === srcRel) throw new VaultError(`Note already has that name: ${srcRel}`);
    return this.relocate('rename_note', srcRel, destRel, 'note');
  }

  async moveFolder(pathArg: string, newPathArg: string) {
    const srcRel = checkRelPath(pathArg);
    const destRel = checkRelFolder(newPathArg);
    if (destRel === '') throw new VaultError('new_path is required; the vault root already exists');
    if (isInside(srcRel, destRel)) throw new VaultError(`Cannot move a folder into itself: ${srcRel} -> ${destRel}`);
    return this.relocate('move_folder', srcRel, destRel, 'folder');
  }

  /** Read every note into the vault's cache ahead of the first move, so that move doesn't pay for it. */
  async warm() {
    const start = performance.now();
    const notes = await this.vault.loadAllNotes();
    this.log(JSON.stringify({ event: 'timing', tool: 'warm_link_index', notes: notes.length, ms: { total: Math.round(performance.now() - start) } }));
  }

  async deleteNote(pathArg: string) {
    const src = await this.paths.resolveSource(pathArg, 'note');
    return this.writer.withLock(STRUCTURE_LOCK, async () => {
      const trash = path.join(this.paths.root, '.trash');
      try {
        const st = await fs.lstat(trash);
        if (!st.isDirectory()) throw new VaultError('The vault .trash is not a plain folder; refusing to delete');
      } catch (e) {
        if (e instanceof VaultError) throw e;
        await fs.mkdir(trash);
      }
      const snapshot = await this.snapshot('delete_note', src.rel);
      const name = path.posix.basename(src.rel);
      const stem = name.slice(0, -3);
      const trashed = await this.writer.withLock(src.rel, async () => {
        // Keep anything already in the trash: pick the first free name.
        for (let i = 1; i <= 1000; i++) {
          const candidate = i === 1 ? name : `${stem} ${i}.md`;
          try {
            await linkNoReplace(src.abs, path.join(trash, candidate));
          } catch (e) {
            if (e instanceof VaultError && e.message === 'exists') continue;
            throw e;
          }
          await fs.unlink(src.abs);
          return `.trash/${candidate}`;
        }
        throw new VaultError(`Too many notes named ${name} in .trash; empty it first`);
      });
      this.log(JSON.stringify({ event: 'delete', tool: 'delete_note', path: src.rel, trashed_to: trashed }));
      return { path: src.rel, trashed_to: trashed, snapshot };
    });
  }

  /**
   * Move a note or folder to destRel, then fix every link the move would otherwise break.
   * If the source is gone and destRel holds exactly what an earlier call moved there, report the earlier result
   * instead of failing, so a client that lost the connection can safely retry.
   */
  private async relocate(tool: string, srcRel: string, destRel: string, kind: 'note' | 'folder') {
    return this.writer.withLock(STRUCTURE_LOCK, async () => {
      const t = new Timer();
      let src: { rel: string; abs: string };
      try {
        src = await this.paths.resolveSource(srcRel, kind);
      } catch (e) {
        const done = e instanceof VaultError && e.message.startsWith('Not found') ? await this.alreadyDone(kind, srcRel, destRel) : null;
        if (!done) throw e;
        this.log(JSON.stringify({ event: 'timing', tool, from: srcRel, to: destRel, already_done: true, ms: t.done() }));
        return done;
      }
      const dest = await this.paths.resolveDestination(destRel);
      const newRel = (rel: string) =>
        rel === src.rel ? dest.rel : kind === 'folder' && isInside(src.rel, rel) ? dest.rel + rel.slice(src.rel.length) : rel;

      // How every link resolves now, before anything changes.
      const files = await this.vault.listFiles();
      const before = new LinkResolver(files.map((f) => f.rel));
      const after = new LinkResolver(files.map((f) => newRel(f.rel)));
      const notes = files.filter((f) => f.isNote && f.abs === path.join(this.paths.root, ...f.rel.split('/')));
      t.lap('walk');

      // Find the notes that need link changes, from the vault's note cache (only changed notes are read again).
      const { todo, report } = await this.planLinks(notes, before, after, newRel);
      t.lap('plan');

      const snapshot = await this.snapshot(tool, src.rel);
      t.lap('snapshot');
      await fs.mkdir(path.dirname(dest.abs), { recursive: true });
      let moved = 0;
      if (kind === 'note') {
        await this.writer.withLock(src.rel, async () => {
          await linkNoReplace(src.abs, dest.abs).catch((e) => {
            throw e instanceof VaultError && e.message === 'exists' ? new VaultError(`Already exists: ${dest.rel}`) : e;
          });
          await fs.unlink(src.abs);
        });
        moved = 1;
      } else {
        // mkdir claims the name (it fails if anything is there); rename then replaces the empty folder.
        try {
          await fs.mkdir(dest.abs);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultError(`Already exists: ${dest.rel}`);
          throw e;
        }
        try {
          await fs.rename(src.abs, dest.abs);
        } catch (e) {
          await fs.rmdir(dest.abs).catch(() => undefined);
          throw e;
        }
        moved = files.filter((f) => isInside(src.rel, f.rel)).length;
      }
      this.log(JSON.stringify({ event: 'move', tool, from: src.rel, to: dest.rel }));
      t.lap('move');

      await this.fixLinks(tool, todo, before, after, newRel, report);
      t.lap('links');
      const result = {
        from: src.rel,
        to: dest.rel,
        ...(kind === 'folder' ? { files_moved: moved } : {}),
        snapshot,
        ...report,
      };
      this.remember(kind, src.rel, dest.rel, await fingerprint(dest.abs, kind), result);
      t.lap('record');
      this.log(
        JSON.stringify({
          event: 'timing',
          tool,
          from: src.rel,
          to: dest.rel,
          notes_scanned: notes.length,
          notes_to_fix: todo.length,
          ms: t.done(),
        }),
      );
      return result;
    });
  }

  /**
   * Work out which notes have links whose target would change because of the move. A link needs a change only if
   * it resolved before the move and would now resolve somewhere else. Links that never resolved are left alone.
   */
  private async planLinks(notes: VaultFile[], before: LinkResolver, after: LinkResolver, newRel: (rel: string) => string) {
    const report: LinkReport = { links_updated: [], links_not_updated: [] };
    const todo: string[] = [];
    for (const note of notes) {
      const newSrc = newRel(note.rel);
      if (note.size > this.cfg.readMaxBytes) {
        report.links_not_updated.push({ path: newSrc, reason: 'note is larger than READ_MAX_BYTES, links not checked' });
        continue;
      }
      let loaded;
      try {
        loaded = await this.vault.loadNote(note);
      } catch {
        report.links_not_updated.push({ path: newSrc, reason: 'could not read this note' });
        continue;
      }
      const { edits, stuck } = planEdits(loaded.text, loaded.parsed.links, note.rel, newSrc, before, after, newRel);
      if (edits.length + stuck > 0) todo.push(note.rel);
    }
    return { todo, report };
  }

  /** Rewrite the links in each note that planLinks picked, re-reading the note from disk under its lock. */
  private async fixLinks(
    tool: string,
    todo: string[],
    before: LinkResolver,
    after: LinkResolver,
    newRel: (rel: string) => string,
    report: LinkReport,
  ) {
    for (const oldSrc of todo) {
      const newSrc = newRel(oldSrc);
      try {
        const target = await this.paths.resolveForWrite(newSrc);
        const result = await this.writer.withLock(target.rel, async () => {
          const text = await fs.readFile(target.abs, 'utf8');
          const { edits, stuck } = planEdits(text, parseNote(text).links, oldSrc, newSrc, before, after, newRel);
          if (edits.length === 0) return { changed: 0, stuck };
          let next = text;
          for (const e of [...edits].sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.text + next.slice(e.end);
          await this.writer.replace(tool, target.rel, target.abs, next);
          return { changed: edits.length, stuck };
        });
        if (result.changed > 0) report.links_updated.push({ path: target.rel, links: result.changed });
        if (result.stuck > 0) report.links_not_updated.push({ path: target.rel, reason: `${result.stuck} link(s) could not be rewritten to an unambiguous form` });
      } catch (e) {
        const reason = e instanceof VaultError ? e.message : 'could not rewrite this note';
        if (!(e instanceof VaultError)) console.error(`${tool}: link update failed for ${newSrc}:`, e);
        report.links_not_updated.push({ path: newSrc, reason });
      }
    }
  }

  /** Remember a finished move so a retry of the same call can be recognised. Keeps the most recent ones. */
  private remember(kind: string, from: string, to: string, print: string | null, result: object) {
    if (print === null) return;
    const key = `${kind}\0${from}\0${to}`;
    this.done.delete(key);
    this.done.set(key, { print, result });
    while (this.done.size > DONE_MAX) this.done.delete(this.done.keys().next().value!);
  }

  /** The earlier result, if this exact move already happened and the destination still has the same content. */
  private async alreadyDone(kind: 'note' | 'folder', from: string, to: string) {
    const rec = this.done.get(`${kind}\0${from}\0${to}`);
    if (!rec) return null;
    let dest;
    try {
      dest = await this.paths.resolveSource(to, kind);
    } catch {
      return null;
    }
    if ((await fingerprint(dest.abs, kind)) !== rec.print) return null;
    return {
      ...rec.result,
      already_done: true,
      note: `This ${kind === 'note' ? 'note' : 'folder'} was already moved to ${to} by an earlier call, and its content is unchanged. Nothing was changed this time. The link report is from that earlier call.`,
    };
  }

  /** Run the snapshot script if it is installed. Refuse the change if it is installed but fails. */
  private async snapshot(tool: string, rel: string): Promise<string> {
    const script = this.cfg.snapshotPath;
    const message = `Before ${tool} ${rel}`;
    try {
      await fs.access(script, fs.constants.X_OK);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.log(JSON.stringify({ event: 'snapshot', skipped: 'script not installed', message }));
        return 'skipped: snapshot script not installed';
      }
      throw new VaultError('The snapshot script exists but cannot be run; nothing was changed');
    }
    await new Promise<void>((resolve, reject) => {
      execFile(script, [message], { cwd: this.paths.root, timeout: SNAPSHOT_TIMEOUT_MS }, (err, _stdout, stderr) => {
        if (!err) return resolve();
        console.error(`snapshot failed (${message}):`, String(stderr).trim() || err.message);
        reject(new VaultError('The snapshot script failed, so nothing was changed. See the server log.'));
      });
    });
    this.log(JSON.stringify({ event: 'snapshot', message }));
    return 'taken';
  }
}

/** A note path from the client: vault-relative and ending in .md. */
function checkNotePath(rel: string): string {
  const r = checkRelPath(rel);
  if (!r.toLowerCase().endsWith('.md')) throw new VaultError(`Not a Markdown note: ${r}`);
  return r;
}

/**
 * What a moved note or folder holds, to tell whether a retry finds it unchanged: the note's SHA-256, or for a
 * folder the path of every file with the SHA-256 of each note and the size and modified time of everything else
 * (attachments can be large, and a move keeps their modified time). Dot entries are skipped, as the vault walker
 * does. Null if it can't be read.
 */
async function fingerprint(abs: string, kind: 'note' | 'folder'): Promise<string | null> {
  try {
    if (kind === 'note') return sha256(await fs.readFile(abs));
    const entries = await fs.readdir(abs, { recursive: true, withFileTypes: true });
    const lines: string[] = [];
    for (const e of entries) {
      const full = path.join(e.parentPath, e.name);
      const rel = path.relative(abs, full).split(path.sep).join('/');
      if (rel.split('/').some((p) => p.startsWith('.'))) continue;
      if (e.isFile() && isNotePath(rel)) lines.push(`${rel}\0${sha256(await fs.readFile(full))}`);
      else if (e.isFile()) {
        const st = await fs.stat(full);
        lines.push(`${rel}\0${st.size}:${st.mtimeMs}`);
      } else if (e.isSymbolicLink()) lines.push(`${rel}\0link:${await fs.readlink(full)}`);
    }
    return sha256(lines.sort().join('\n'));
  } catch {
    return null;
  }
}

/** Milliseconds spent in each step of a change, for the timing log line. */
class Timer {
  private start = performance.now();
  private last = this.start;
  private laps: Record<string, number> = {};

  lap(name: string) {
    const now = performance.now();
    this.laps[name] = Math.round(now - this.last);
    this.last = now;
  }

  done() {
    return { ...this.laps, total: Math.round(performance.now() - this.start) };
  }
}

/** Hard-link src to dst. Fails with VaultError('exists') instead of replacing an existing file. */
async function linkNoReplace(src: string, dst: string) {
  try {
    await fs.link(src, dst);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new VaultError('exists');
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw e;
    // Filesystem without hard links: copy exclusively, which also refuses to overwrite.
    try {
      await fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL);
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultError('exists');
      throw e2;
    }
  }
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Work out the link rewrites one note needs after a move. */
function planEdits(
  text: string,
  links: RawLink[],
  oldSrc: string,
  newSrc: string,
  before: LinkResolver,
  after: LinkResolver,
  newRel: (rel: string) => string,
): { edits: Edit[]; stuck: number } {
  const edits: Edit[] = [];
  let stuck = 0;
  let lastEnd = -1;
  for (const link of [...links].sort((a, b) => a.start - b.start)) {
    if (!link.target || link.start < lastEnd) continue;
    const was = before.resolve(link.target, oldSrc);
    if (was === null) continue;
    const want = newRel(was);
    if (after.resolve(link.target, newSrc) === want) continue;
    const target = newTarget(link, want, newSrc, after);
    if (target === null) {
      stuck++;
      continue;
    }
    edits.push({ start: link.start, end: link.end, text: rebuild(link, text.slice(link.start, link.end), target) });
    lastEnd = link.end;
  }
  return { edits, stuck };
}

/** The shortest link text that resolves to `want`, in the same style as the original link. */
function newTarget(link: RawLink, want: string, src: string, after: LinkResolver): string | null {
  const keepExt = /\.md$/i.test(link.target) || !isNotePath(want);
  const full = keepExt ? want : want.slice(0, -3);
  const name = path.posix.basename(full);
  let candidates: string[];
  if (link.kind === 'wikilink') {
    candidates = link.target.includes('/') ? [full, name] : [name, full];
  } else {
    const dir = path.posix.dirname(src);
    candidates = [path.posix.relative(dir === '.' ? '' : dir, full), full];
  }
  return candidates.find((c) => after.resolve(c, src) === want) ?? null;
}

/** Return the original link with only its target replaced. Keeps '!', '#fragment', '|alias', title and <...> form. */
function rebuild(link: RawLink, original: string, target: string): string {
  if (link.kind === 'wikilink') {
    const bang = original.startsWith('!') ? '!' : '';
    const inner = original.slice(bang.length + 2, -2);
    const cut = inner.search(/\\?\||#/);
    return `${bang}[[${target}${cut < 0 ? '' : inner.slice(cut)}]]`;
  }
  // Markdown link: the link text can't contain ']', so the first '](' starts the destination.
  const open = original.indexOf('](') + 2;
  const rest = original.slice(open);
  const angle = rest.startsWith('<');
  const hrefEnd = angle ? rest.indexOf('>') + 1 : rest.search(/[)\s]/);
  const href = angle ? rest.slice(1, hrefEnd - 1) : rest.slice(0, hrefEnd);
  const hash = href.indexOf('#');
  const fragment = hash < 0 ? '' : href.slice(hash);
  const dest = angle ? `<${target}${fragment}>` : target.replace(/[ ()]/g, (c) => encodeURIComponent(c).replace('(', '%28').replace(')', '%29')) + fragment;
  return original.slice(0, open) + dest + rest.slice(hrefEnd);
}
