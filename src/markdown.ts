import { parseDocument, isMap } from 'yaml';

export interface Heading {
  level: number;
  text: string;
  line: number; // 1-based line number in the whole file
}

export interface RawLink {
  kind: 'wikilink' | 'markdown';
  embed: boolean;
  target: string; // path or name, no #fragment
  fragment: string | null;
  line: number;
  start: number; // offset of the whole link (including any '!') in the text
  end: number;
}

export interface ParsedNote {
  frontmatterRaw: string | null; // YAML text between the --- fences
  frontmatter: Record<string, unknown> | null;
  frontmatterError: string | null;
  body: string;
  bodyStartLine: number; // 1-based line where the body starts
  headings: Heading[];
  tags: string[]; // lowercased, no leading '#', unique
  links: RawLink[];
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(text: string): { raw: string | null; body: string; bodyStartLine: number } {
  const m = FM_RE.exec(text);
  if (!m) return { raw: null, body: text, bodyStartLine: 1 };
  const consumed = m[0];
  const lines = consumed.split('\n').length - (consumed.endsWith('\n') ? 1 : 0);
  return { raw: m[1] ?? '', body: text.slice(consumed.length), bodyStartLine: lines + 1 };
}

export function parseFrontmatter(raw: string): { data: Record<string, unknown> | null; error: string | null } {
  if (raw.trim() === '') return { data: {}, error: null };
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) return { data: null, error: doc.errors[0]!.message.split('\n')[0]! };
  if (doc.contents === null) return { data: {}, error: null };
  if (!isMap(doc.contents)) return { data: null, error: 'Frontmatter is not a key/value map' };
  return { data: doc.toJS() as Record<string, unknown>, error: null };
}

/** Replace fenced code blocks and inline code with spaces so links and tags inside code are ignored. */
export function maskCode(text: string): string {
  const lines = text.split('\n');
  let fence: string | null = null;
  const out = lines.map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
      return ' '.repeat(line.length);
    }
    if (m) {
      fence = m[1]!;
      return ' '.repeat(line.length);
    }
    return line.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));
  });
  return out.join('\n');
}

export function extractHeadings(body: string, startLine: number): Heading[] {
  const masked = maskCode(body).split('\n');
  const out: Heading[] = [];
  masked.forEach((line, i) => {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: startLine + i });
  });
  return out;
}

const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\-/]+)/gu;

export function normaliseTag(t: string): string {
  return t.trim().replace(/^#/, '').toLowerCase();
}

function frontmatterTags(fm: Record<string, unknown> | null): string[] {
  if (!fm) return [];
  const out: string[] = [];
  for (const key of ['tags', 'tag']) {
    const v = fm[key];
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === 'string' || typeof item === 'number') out.push(String(item));
    } else if (typeof v === 'string') {
      out.push(...v.split(/[,\s]+/));
    }
  }
  return out.map(normaliseTag).filter(Boolean);
}

export function extractInlineTags(body: string): string[] {
  const out: string[] = [];
  for (const m of maskCode(body).matchAll(TAG_RE)) {
    const tag = m[2]!.replace(/\/+$/, '');
    // Obsidian requires at least one non-numeric character.
    if (tag && !/^[\d/]+$/.test(tag)) out.push(normaliseTag(tag));
  }
  return out;
}

const WIKI_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;
const MD_LINK_RE = /(!?)\[[^\]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)/g;

function lineAt(text: string, index: number, startLine: number): number {
  let n = startLine;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function extractLinks(text: string, startLine = 1): RawLink[] {
  const masked = maskCode(text);
  const links: RawLink[] = [];
  for (const m of masked.matchAll(WIKI_RE)) {
    // In tables Obsidian writes the alias separator as '\\|'.
    const inner = m[2]!.split(/\\?\|/)[0]!;
    const hash = inner.indexOf('#');
    const target = (hash >= 0 ? inner.slice(0, hash) : inner).trim();
    const fragment = hash >= 0 ? inner.slice(hash + 1).trim() : null;
    const start = m.index!;
    links.push({ kind: 'wikilink', embed: m[1] === '!', target, fragment, line: lineAt(masked, start, startLine), start, end: start + m[0].length });
  }
  for (const m of masked.matchAll(MD_LINK_RE)) {
    let href = (m[2] ?? m[3] ?? '').trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // URLs and other schemes
    if (href.startsWith('#') || href === '') continue;
    const hash = href.indexOf('#');
    const fragment = hash >= 0 ? href.slice(hash + 1) : null;
    if (hash >= 0) href = href.slice(0, hash);
    try {
      href = decodeURIComponent(href);
    } catch {
      /* keep as written */
    }
    const start = m.index!;
    links.push({ kind: 'markdown', embed: m[1] === '!', target: href, fragment, line: lineAt(masked, start, startLine), start, end: start + m[0].length });
  }
  return links;
}

export function parseNote(text: string): ParsedNote {
  const { raw, body, bodyStartLine } = splitFrontmatter(text);
  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | null = null;
  if (raw !== null) {
    const r = parseFrontmatter(raw);
    frontmatter = r.data;
    frontmatterError = r.error;
  }
  const tags = [...new Set([...frontmatterTags(frontmatter), ...extractInlineTags(body)])];
  return {
    frontmatterRaw: raw,
    frontmatter,
    frontmatterError,
    body,
    bodyStartLine,
    headings: extractHeadings(body, bodyStartLine),
    tags,
    // Wikilinks in properties count too, as in Obsidian.
    links: extractLinks(text, 1),
  };
}

/**
 * Find a heading's section in the body: from the heading line up to the next heading of the same or higher level.
 * Returns character offsets into `body`.
 */
export function findSection(body: string, heading: string): { start: number; contentStart: number; end: number; level: number } | null {
  const want = heading.trim().replace(/^#+\s*/, '').toLowerCase();
  const masked = maskCode(body);
  const lines = masked.split('\n');
  let offset = 0;
  let found: { start: number; contentStart: number; level: number } | null = null;
  for (const line of lines) {
    const m = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (m) {
      const level = m[1]!.length;
      if (found && level <= found.level) return { ...found, end: offset };
      if (!found && m[2]!.trim().toLowerCase() === want) {
        found = { start: offset, contentStart: offset + line.length + 1, level };
      }
    }
    offset += line.length + 1;
  }
  if (found) return { ...found, contentStart: Math.min(found.contentStart, body.length), end: body.length };
  return null;
}
