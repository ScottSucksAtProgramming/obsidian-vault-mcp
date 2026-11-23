import { describe, expect, it } from 'vitest';
import { extractLinks, findSection, parseNote } from '../src/markdown.js';
import { LinkResolver } from '../src/vault.js';

describe('parseNote', () => {
  it('parses frontmatter, tags and headings', () => {
    const p = parseNote('---\ntype: project\ntags: [a/b, c]\n---\n# Title\n\nText #inline and #123 and `#code`\n\n## Sub\n');
    expect(p.frontmatter).toEqual({ type: 'project', tags: ['a/b', 'c'] });
    expect(p.frontmatterError).toBeNull();
    expect(p.tags.sort()).toEqual(['a/b', 'c', 'inline']);
    expect(p.headings).toEqual([
      { level: 1, text: 'Title', line: 5 },
      { level: 2, text: 'Sub', line: 9 },
    ]);
  });

  it('reports malformed frontmatter without failing', () => {
    const p = parseNote('---\ntitle: [unclosed\n---\nBody\n');
    expect(p.frontmatter).toBeNull();
    expect(p.frontmatterError).toBeTruthy();
    expect(p.body).toBe('Body\n');
  });

  it('rejects frontmatter that is not a map', () => {
    const p = parseNote('---\n- a\n- b\n---\nBody\n');
    expect(p.frontmatterError).toMatch(/not a key\/value map/);
  });

  it('treats a note without frontmatter as all body', () => {
    const p = parseNote('# Just a heading\n');
    expect(p.frontmatterRaw).toBeNull();
    expect(p.frontmatter).toBeNull();
  });

  it('ignores headings, tags and links inside code fences', () => {
    const p = parseNote('```\n# not heading\n#nottag [[Nope]]\n```\n~~~\n## also not\n~~~\n');
    expect(p.headings).toEqual([]);
    expect(p.tags).toEqual([]);
    expect(p.links).toEqual([]);
  });
});

describe('extractLinks', () => {
  it('finds wikilinks, embeds and Markdown links, skipping URLs', () => {
    const links = extractLinks('[[A]] [[B#H|alias]] ![[c.png]] [x](d%20e.md#frag) ![](img/f.jpg) [web](https://example.com) [[#Local]]');
    expect(links.map((l) => [l.kind, l.embed, l.target, l.fragment])).toEqual([
      ['wikilink', false, 'A', null],
      ['wikilink', false, 'B', 'H'],
      ['wikilink', true, 'c.png', null],
      ['wikilink', false, '', 'Local'],
      ['markdown', false, 'd e.md', 'frag'],
      ['markdown', true, 'img/f.jpg', null],
    ]);
  });
});

describe('findSection', () => {
  const body = '# T\n\n## Inputs\n\n### Greens\n\ng\n\n## Turning\n\nt\n';
  it('spans subsections and stops at the next same-level heading', () => {
    const s = findSection(body, 'Inputs')!;
    expect(body.slice(s.start, s.end)).toBe('## Inputs\n\n### Greens\n\ng\n\n');
  });
  it('runs to the end for the last section', () => {
    const s = findSection(body, '## turning')!;
    expect(body.slice(s.start, s.end)).toBe('## Turning\n\nt\n');
  });
  it('returns null when missing', () => {
    expect(findSection(body, 'Nope')).toBeNull();
  });
});

describe('LinkResolver', () => {
  const r = new LinkResolver(['A.md', 'Beds/A.md', 'Beds/Deep/x.png', 'x.png', 'Media/y.png', 'Media/Other/y.png', 'Beds/Note.md']);
  it('prefers an exact vault path, then shortest suffix match', () => {
    expect(r.resolve('A', 'Z.md')).toBe('A.md');
    expect(r.resolve('Beds/A', 'Z.md')).toBe('Beds/A.md');
    expect(r.resolve('y.png', 'Z.md')).toBe('Media/y.png');
    expect(r.resolve('Other/y.png', 'Z.md')).toBe('Media/Other/y.png');
  });
  it('resolves relative paths from the source note first', () => {
    expect(r.resolve('A.md', 'Beds/Note.md')).toBe('Beds/A.md');
    expect(r.resolve('../x.png', 'Beds/Note.md')).toBe('x.png');
  });
  it('is case-insensitive and returns null when nothing matches', () => {
    expect(r.resolve('a', 'Z.md')).toBe('A.md');
    expect(r.resolve('missing', 'Z.md')).toBeNull();
    expect(r.resolve('../../etc/passwd', 'Beds/Note.md')).toBeNull();
  });
  it('breaks ties between same-named files by shortest path, then alphabetically', () => {
    const t = new LinkResolver(['b/c/X.md', 'zz/X.md', 'aa/X.md', 'B2/c/x.md', 'X.png', 'Deep/Y.md.md']);
    expect(t.resolve('X', null)).toBe('aa/X.md');
    expect(t.resolve('c/x', null)).toBe('b/c/X.md');
    expect(t.resolve('x.png', null)).toBe('X.png');
    expect(t.resolve('Y.md', null)).toBe('Deep/Y.md.md');
    expect(t.resolve('c/', null)).toBeNull();
    expect(t.resolve('a/X', null)).toBeNull();
  });
});
