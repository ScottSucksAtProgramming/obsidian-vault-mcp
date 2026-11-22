import fs from 'node:fs/promises';
import { VaultError } from './paths.js';
import { LinkResolver, type Vault } from './vault.js';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

export const isImagePath = (rel: string) => IMAGE_EXTENSIONS.includes(rel.split('.').pop()?.toLowerCase() ?? '');

/** Detect the image type from the file's first bytes, not its name. */
export function detectMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export type ImageResult =
  | { kind: 'binary'; path: string; mimeType: string; data: string; bytes: number }
  | { kind: 'svg'; path: string; text: string; bytes: number };

export interface ImageRequest {
  path?: string;
  note?: string;
  name?: string;
  index?: number;
}

/** Image links (embeds or plain links) in a note, in order, resolved to vault paths. */
export async function imageLinksInNote(vault: Vault, noteRel: string): Promise<{ written: string; resolved: string | null }[]> {
  const note = await vault.loadNote(noteRel);
  const files = (await vault.listFiles()).map((f) => f.rel);
  const resolver = new LinkResolver(files);
  return note.parsed.links
    .filter((l) => isImagePath(l.target))
    .map((l) => ({ written: l.target, resolved: resolver.resolve(l.target, note.file.rel) }));
}

export async function readImage(vault: Vault, req: ImageRequest, maxBytes: number): Promise<ImageResult> {
  let rel: string;
  if (req.path) {
    rel = req.path;
  } else if (req.note) {
    const links = await imageLinksInNote(vault, req.note);
    if (links.length === 0) throw new VaultError(`No image embeds or links in ${req.note}`);
    let pick;
    if (req.name) {
      const want = req.name.trim().toLowerCase();
      pick = links.find((l) => l.written.toLowerCase() === want) ?? links.find((l) => l.resolved?.toLowerCase().endsWith(want));
      if (!pick) throw new VaultError(`No image named '${req.name}' in ${req.note}. Images: ${links.map((l) => l.written).join(', ')}`);
    } else {
      const i = req.index ?? 0;
      pick = links[i];
      if (!pick) throw new VaultError(`Index ${i} out of range; ${req.note} has ${links.length} image link(s)`);
    }
    if (!pick.resolved) throw new VaultError(`Image '${pick.written}' in ${req.note} does not match any file in the vault`);
    rel = pick.resolved;
  } else {
    throw new VaultError('Give either path, or note (with optional name or index)');
  }

  const file = await vault.statFile(rel);
  if (!isImagePath(file.rel)) throw new VaultError(`Not a supported image (png, jpeg, gif, webp, svg): ${file.rel}`);
  if (file.size > maxBytes) {
    throw new VaultError(`Image is ${file.size} bytes, over the IMAGE_MAX_BYTES limit of ${maxBytes}: ${file.rel}`);
  }
  const buf = await fs.readFile(file.abs);
  if (file.rel.toLowerCase().endsWith('.svg')) {
    const text = buf.toString('utf8');
    if (!/<svg[\s>]/i.test(text)) throw new VaultError(`File does not look like an SVG: ${file.rel}`);
    return { kind: 'svg', path: file.rel, text, bytes: buf.length };
  }
  const mimeType = detectMime(buf);
  if (!mimeType) throw new VaultError(`File contents are not png, jpeg, gif or webp: ${file.rel}`);
  return { kind: 'binary', path: file.rel, mimeType, data: buf.toString('base64'), bytes: buf.length };
}
