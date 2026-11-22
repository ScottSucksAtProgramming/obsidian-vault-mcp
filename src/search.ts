import { execFile } from 'node:child_process';
import { VaultError } from './paths.js';

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  folder?: string; // vault-relative, already checked
  limit: number;
}

/**
 * Full-text search with ripgrep. Runs via execFile with an argument array (no shell).
 * Fixed-string matching unless `regex` is set. Hidden files and folders are skipped (ripgrep's default),
 * and .gitignore files inside the vault are ignored so they can't hide notes.
 */
export function searchNotes(rgPath: string, vaultDir: string, opts: SearchOptions): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const args = [
    '--json',
    '--no-config',
    '--no-ignore',
    '--glob',
    '*.md',
    '--max-columns',
    '500',
    '--max-columns-preview',
    '--max-filesize',
    '5M',
    opts.caseSensitive ? '--case-sensitive' : '--ignore-case',
  ];
  if (!opts.regex) args.push('--fixed-strings');
  // `-e` keeps a query that starts with '-' from being read as an option.
  args.push('-e', opts.query, '--', opts.folder ? opts.folder : '.');

  return new Promise((resolve, reject) => {
    execFile(
      rgPath,
      args,
      { cwd: vaultDir, maxBuffer: 32 * 1024 * 1024, timeout: 15_000, windowsHide: true },
      (err, stdout, stderr) => {
        const code: unknown = err ? (err as { code?: unknown }).code : 0;
        if (code === 'ENOENT') return reject(new VaultError('ripgrep (rg) is not installed on the server'));
        // Exit 1 means no matches. Exit 2 with output means some files were unreadable but others matched.
        if (err && code !== 1 && !(code === 2 && stdout)) {
          const msg = String(stderr || '').split('\n')[0] || 'search failed';
          return reject(new VaultError(`Search failed: ${msg.replaceAll(vaultDir, '<vault>')}`));
        }
        const hits: SearchHit[] = [];
        let truncated = false;
        for (const line of String(stdout).split('\n')) {
          if (!line) continue;
          let ev: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type !== 'match' || !ev.data?.path?.text) continue;
          if (hits.length >= opts.limit) {
            truncated = true;
            break;
          }
          hits.push({
            path: ev.data.path.text.replace(/^\.\//, ''),
            line: ev.data.line_number ?? 0,
            text: (ev.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 500),
          });
        }
        resolve({ hits, truncated });
      },
    );
  });
}
