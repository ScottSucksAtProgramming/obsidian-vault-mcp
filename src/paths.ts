import fs from 'node:fs/promises';
import path from 'node:path';

/** An error whose message is safe to show to the client (vault-relative, no host paths). */
export class VaultError extends Error {}

/**
 * Check a client-supplied vault-relative path and return it in normal form.
 * Rejects absolute paths, '..', empty segments, and any dot-prefixed segment.
 */
export function checkRelPath(rel: unknown): string {
  if (typeof rel !== 'string' || rel.trim() === '') throw new VaultError('Path is required');
  if (rel.includes('\0')) throw new VaultError('Path contains a NUL byte');
  if (rel.includes('\\')) throw new VaultError('Use forward slashes in paths');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new VaultError('Paths must be vault-relative, not absolute');
  const parts = rel.split('/');
  // Allow one trailing slash on folders.
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') throw new VaultError(`Invalid path segment in '${rel}'`);
    if (p.startsWith('.')) throw new VaultError(`Dot-prefixed paths are not allowed: '${rel}'`);
  }
  return parts.join('/');
}

/** Folder argument: '' (or '/') means the vault root. */
export function checkRelFolder(folder: string | undefined): string {
  if (folder === undefined) return '';
  const f = folder.trim();
  if (f === '' || f === '/') return '';
  return checkRelPath(f);
}

export function isInside(dir: string, rel: string): boolean {
  return dir === '' || rel === dir || rel.startsWith(dir + '/');
}

export class VaultPaths {
  constructor(
    readonly root: string, // realpath of the vault
    private readonly readonlyDirs: string[],
  ) {}

  /** Vault-relative form of an absolute real path, or null if it is outside the vault. */
  relOf(absReal: string): string | null {
    if (absReal === this.root) return '';
    if (!absReal.startsWith(this.root + path.sep)) return null;
    return absReal.slice(this.root.length + 1).split(path.sep).join('/');
  }

  /** Resolve an existing file or folder, following symlinks only if they stay inside the vault. */
  async resolveExisting(relInput: string): Promise<{ rel: string; abs: string }> {
    const rel = checkRelPath(relInput);
    let real: string;
    try {
      real = await fs.realpath(path.join(this.root, rel));
    } catch {
      throw new VaultError(`Not found: ${rel}`);
    }
    const realRel = this.relOf(real);
    if (realRel === null) throw new VaultError(`Path leads outside the vault: ${rel}`);
    // A symlink inside the vault must not point at a dot folder such as .obsidian.
    if (realRel !== '') checkRelPath(realRel);
    return { rel, abs: real };
  }

  isReadOnly(rel: string): boolean {
    return this.readonlyDirs.some((d) => isInside(d, rel));
  }

  /**
   * Resolve a path for writing a Markdown note. The target may not exist yet.
   * Refuses read-only folders, non-.md files, symlinked targets, and parents that lead outside the vault.
   */
  async resolveForWrite(relInput: string): Promise<{ rel: string; abs: string; exists: boolean }> {
    const rel = checkRelPath(relInput);
    if (!rel.toLowerCase().endsWith('.md')) throw new VaultError(`Only .md files can be written: ${rel}`);
    if (this.isReadOnly(rel)) throw new VaultError(`Folder is read-only: ${rel}`);

    // Find the nearest existing ancestor and make sure it really is inside the vault.
    const parts = rel.split('/');
    let ancestor = parts.slice(0, -1);
    for (;;) {
      const candidate = path.join(this.root, ...ancestor);
      try {
        const real = await fs.realpath(candidate);
        const realRel = this.relOf(real);
        if (realRel === null) throw new VaultError(`Path leads outside the vault: ${rel}`);
        if (realRel !== '') checkRelPath(realRel);
        if (this.isReadOnly(realRel)) throw new VaultError(`Folder is read-only: ${rel}`);
        const st = await fs.stat(real);
        if (!st.isDirectory()) throw new VaultError(`Parent is not a folder: ${rel}`);
        // Rebuild the target under the real ancestor so later steps never follow a symlink out.
        const rest = parts.slice(ancestor.length);
        const abs = path.join(real, ...rest);
        let exists = false;
        try {
          const lst = await fs.lstat(abs);
          if (lst.isSymbolicLink()) throw new VaultError(`Refusing to write through a symlink: ${rel}`);
          if (!lst.isFile()) throw new VaultError(`Not a file: ${rel}`);
          exists = true;
        } catch (e) {
          if (e instanceof VaultError) throw e;
        }
        return { rel, abs, exists };
      } catch (e) {
        if (e instanceof VaultError) throw e;
        if (ancestor.length === 0) throw new VaultError('Vault root is not accessible');
        ancestor = ancestor.slice(0, -1);
      }
    }
  }
}
