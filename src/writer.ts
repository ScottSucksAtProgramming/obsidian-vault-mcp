import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultError, VaultPaths } from './paths.js';
import { sha256 } from './vault.js';

export class Writer {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly paths: VaultPaths,
    private readonly writeMaxBytes: number,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  /** Run `fn` while holding this server's lock for one file. Calls for the same file run one at a time. */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    }
  }

  private checkSize(content: string, rel: string) {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.writeMaxBytes) {
      throw new VaultError(`Write would exceed WRITE_MAX_BYTES (${bytes} > ${this.writeMaxBytes}): ${rel}`);
    }
    return bytes;
  }

  private tempPath(abs: string) {
    // Dot-prefixed so the vault walkers and Obsidian ignore it while it exists.
    return path.join(path.dirname(abs), `.${path.basename(abs)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  }

  private logWrite(tool: string, rel: string, bytes: number, content: string) {
    this.log(JSON.stringify({ event: 'write', tool, path: rel, bytes, sha256: sha256(content) }));
  }

  /** Create a new note. Fails if anything already exists at the path; never overwrites. */
  async create(tool: string, rel: string, abs: string, content: string): Promise<{ bytes: number; hash: string }> {
    const bytes = this.checkSize(content, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = this.tempPath(abs);
    await fs.writeFile(tmp, content, { flag: 'wx' });
    try {
      // link() fails with EEXIST instead of replacing, unlike rename().
      await fs.link(tmp, abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw new VaultError(`Note already exists: ${rel}`);
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw e;
      // Filesystem without hard links: exclusive create still refuses to overwrite.
      try {
        await fs.writeFile(abs, content, { flag: 'wx' });
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') throw new VaultError(`Note already exists: ${rel}`);
        throw e2;
      }
    } finally {
      await fs.rm(tmp, { force: true });
    }
    this.logWrite(tool, rel, bytes, content);
    return { bytes, hash: sha256(content) };
  }

  /** Replace an existing note's content atomically (temp file, then rename). */
  async replace(tool: string, rel: string, abs: string, content: string): Promise<{ bytes: number; hash: string }> {
    const bytes = this.checkSize(content, rel);
    const tmp = this.tempPath(abs);
    try {
      const st = await fs.stat(abs);
      await fs.writeFile(tmp, content, { flag: 'wx', mode: st.mode & 0o777 });
      await fs.rename(tmp, abs);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    this.logWrite(tool, rel, bytes, content);
    return { bytes, hash: sha256(content) };
  }

  get vaultPaths() {
    return this.paths;
  }
}
