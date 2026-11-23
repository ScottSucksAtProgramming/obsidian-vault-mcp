import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from './config.js';
import { parseNote, type RawLink } from './markdown.js';
import { checkName, checkRelFolder, isInside, VaultError } from './paths.js';
import { isNotePath, LinkResolver, type Vault } from './vault.js';
import type { Writer } from './writer.js';

const SNAPSHOT_TIMEOUT_MS = 120_000;
const STRUCTURE_LOCK = '\0structure';

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

  private get paths() {
    return this.writer.vaultPaths;
  }

  async moveNote(pathArg: string, folderArg: string) {
    const src = await this.paths.resolveSource(pathArg, 'note');
    const folder = checkRelFolder(folderArg);
    const destRel = folder ? `${folder}/${path.posix.basename(src.rel)}` : path.posix.basename(src.rel);
    if (destRel === src.rel) throw new VaultError(`Note is already in that folder: ${src.rel}`);
    return this.relocate('move_note', src, destRel, 'note');
  }

  async renameNote(pathArg: string, newName: string) {
    const src = await this.paths.resolveSource(pathArg, 'note');
    const name = checkName(newName.replace(/\.md$/i, ''));
    const dir = path.posix.dirname(src.rel);
    const destRel = `${dir === '.' ? '' : dir + '/'}${name}.md`;
    if (destRel === src.rel) throw new VaultError(`Note already has that name: ${src.rel}`);
    return this.relocate('rename_note', src, destRel, 'note');
  }

  async moveFolder(pathArg: string, newPathArg: string) {
    const src = await this.paths.resolveSource(pathArg, 'folder');
    const destRel = checkRelFolder(newPathArg);
    if (destRel === '') throw new VaultError('new_path is required; the vault root already exists');
    if (isInside(src.rel, destRel)) throw new VaultError(`Cannot move a folder into itself: ${src.rel} -> ${destRel}`);
    return this.relocate('move_folder', src, destRel, 'folder');
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

  /** Move a note or folder to destRel, then fix every link the move would otherwise break. */
  private async relocate(tool: string, src: { rel: string; abs: string }, destRel: string, kind: 'note' | 'folder') {
    return this.writer.withLock(STRUCTURE_LOCK, async () => {
      const dest = await this.paths.resolveDestination(destRel);
      const newRel = (rel: string) =>
        rel === src.rel ? dest.rel : kind === 'folder' && isInside(src.rel, rel) ? dest.rel + rel.slice(src.rel.length) : rel;

      // How every link resolves now, before anything changes.
      const files = await this.vault.listFiles();
      const before = new LinkResolver(files.map((f) => f.rel));
      const after = new LinkResolver(files.map((f) => newRel(f.rel)));
      const notes = (await this.vault.listNotes()).filter((f) => f.abs === path.join(this.paths.root, ...f.rel.split('/')));

      const snapshot = await this.snapshot(tool, src.rel);
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

      const report = await this.fixLinks(tool, notes, before, after, newRel);
      return {
        from: src.rel,
        to: dest.rel,
        ...(kind === 'folder' ? { files_moved: moved } : {}),
        snapshot,
        ...report,
      };
    });
  }

  /**
   * Rewrite links whose target would change because of the move. A link is rewritten only if it resolved
   * before the move and now resolves somewhere else. Links that never resolved are left alone.
   */
  private async fixLinks(
    tool: string,
    notes: { rel: string; size: number }[],
    before: LinkResolver,
    after: LinkResolver,
    newRel: (rel: string) => string,
  ): Promise<LinkReport> {
    const report: LinkReport = { links_updated: [], links_not_updated: [] };
    for (const note of notes) {
      const oldSrc = note.rel;
      const newSrc = newRel(oldSrc);
      const plan = (text: string) => planEdits(text, oldSrc, newSrc, before, after, newRel);
      if (note.size > this.cfg.readMaxBytes) {
        report.links_not_updated.push({ path: newSrc, reason: 'note is larger than READ_MAX_BYTES, links not checked' });
        continue;
      }
      try {
        const target = await this.paths.resolveForWrite(newSrc).catch(async (e) => {
          // A read-only note can't be rewritten. Say so only if it actually has links to fix.
          const p = plan(await fs.readFile(path.join(this.paths.root, ...newSrc.split('/')), 'utf8'));
          if (p.edits.length + p.stuck > 0) throw e;
          return null;
        });
        if (!target) continue;
        const result = await this.writer.withLock(target.rel, async () => {
          const text = await fs.readFile(target.abs, 'utf8');
          const { edits, stuck } = plan(text);
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
    return report;
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
  oldSrc: string,
  newSrc: string,
  before: LinkResolver,
  after: LinkResolver,
  newRel: (rel: string) => string,
): { edits: Edit[]; stuck: number } {
  const edits: Edit[] = [];
  let stuck = 0;
  let lastEnd = -1;
  for (const link of parseNote(text).links.sort((a, b) => a.start - b.start)) {
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
