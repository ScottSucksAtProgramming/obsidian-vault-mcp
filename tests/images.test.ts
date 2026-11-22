import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectMime, readImage } from '../src/images.js';
import { GIF, JPEG, makeOps, makeVault, PNG, WEBP, type TestVault } from './helpers.js';

let tv: TestVault;
beforeEach(() => {
  tv = makeVault();
});
afterEach(() => fs.rmSync(tv.base, { recursive: true, force: true }));

const MAX = 5 * 1024 * 1024;

describe('detectMime', () => {
  it('detects formats from bytes', () => {
    expect(detectMime(PNG)).toBe('image/png');
    expect(detectMime(JPEG)).toBe('image/jpeg');
    expect(detectMime(GIF)).toBe('image/gif');
    expect(detectMime(WEBP)).toBe('image/webp');
    expect(detectMime(Buffer.from('hello world!'))).toBeNull();
  });
});

describe('read_image', () => {
  it('reads by vault path with mime from the bytes', async () => {
    const { vault } = makeOps(tv.dir);
    const r = await readImage(vault, { path: 'Media/photo.jpg' }, MAX);
    expect(r).toMatchObject({ kind: 'binary', mimeType: 'image/jpeg', data: JPEG.toString('base64') });
    expect(await readImage(vault, { path: 'Media/anim.gif' }, MAX)).toMatchObject({ mimeType: 'image/gif' });
    expect(await readImage(vault, { path: 'Media/leaf.webp' }, MAX)).toMatchObject({ mimeType: 'image/webp' });
  });

  it('a wrong extension does not fool detection', async () => {
    const { vault } = makeOps(tv.dir);
    fs.copyFileSync(path.join(tv.dir, 'Media', 'photo.jpg'), path.join(tv.dir, 'Media', 'really-jpeg.png'));
    expect(await readImage(vault, { path: 'Media/really-jpeg.png' }, MAX)).toMatchObject({ mimeType: 'image/jpeg' });
    await expect(readImage(vault, { path: 'Media/fake.png' }, MAX)).rejects.toThrow(/not png, jpeg/);
  });

  it('returns SVG as text', async () => {
    const { vault } = makeOps(tv.dir);
    const r = await readImage(vault, { path: 'Media/icon.svg' }, MAX);
    expect(r.kind).toBe('svg');
    expect(r.kind === 'svg' && r.text).toContain('<svg');
  });

  it('resolves ![[name.png]] to the shortest matching path', async () => {
    const { vault } = makeOps(tv.dir);
    const r = await readImage(vault, { note: 'Beds/Tomato Bed.md' }, MAX);
    expect(r.path).toBe('Media/diagram.png');
    const byName = await readImage(vault, { note: 'Beds/Tomato Bed.md', name: 'diagram.png' }, MAX);
    expect(byName.path).toBe('Media/diagram.png');
  });

  it('resolves ![](relative/path.png) from the note folder', async () => {
    const { vault } = makeOps(tv.dir);
    const r = await readImage(vault, { note: 'Beds/Pepper Row.md', index: 0 }, MAX);
    expect(r).toMatchObject({ path: 'Media/photo.jpg', mimeType: 'image/jpeg' });
  });

  it('explains missing or unresolved embeds', async () => {
    const { vault } = makeOps(tv.dir);
    await expect(readImage(vault, { note: 'Lonely.md' }, MAX)).rejects.toThrow(/No image/);
    await expect(readImage(vault, { note: 'Beds/Tomato Bed.md', index: 4 }, MAX)).rejects.toThrow(/out of range/);
    fs.writeFileSync(path.join(tv.dir, 'Ghost.md'), '![[nowhere.png]]\n');
    await expect(readImage(vault, { note: 'Ghost.md' }, MAX)).rejects.toThrow(/does not match any file/);
  });

  it('applies path safety', async () => {
    const { vault } = makeOps(tv.dir);
    await expect(readImage(vault, { path: '../outside/secret.png' }, MAX)).rejects.toThrow();
    await expect(readImage(vault, { path: 'Media/escape.png' }, MAX)).rejects.toThrow(/outside the vault/);
    fs.writeFileSync(path.join(tv.dir, '.obsidian', 'icon.png'), PNG);
    await expect(readImage(vault, { path: '.obsidian/icon.png' }, MAX)).rejects.toThrow(/Dot-prefixed/);
    fs.writeFileSync(path.join(tv.dir, 'Sneaky.md'), '![](../outside/secret.png)\n![[escape.png]]\n');
    await expect(readImage(vault, { note: 'Sneaky.md', index: 0 }, MAX)).rejects.toThrow(/does not match/);
    await expect(readImage(vault, { note: 'Sneaky.md', index: 1 }, MAX)).rejects.toThrow(/does not match/);
  });

  it('refuses images over the size cap with a clear message', async () => {
    const { vault } = makeOps(tv.dir);
    await expect(readImage(vault, { path: 'Media/diagram.png' }, 10)).rejects.toThrow(/over the IMAGE_MAX_BYTES limit of 10/);
  });

  it('refuses non-image files', async () => {
    const { vault } = makeOps(tv.dir);
    await expect(readImage(vault, { path: 'Compost Heap.md' }, MAX)).rejects.toThrow(/Not a supported image/);
  });
});
