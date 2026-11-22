import fs from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { ConfigError, type AccessMode } from './config.js';
import { readImage } from './images.js';
import type { Ops } from './ops.js';
import { checkRelFolder, VaultError } from './paths.js';
import { searchNotes } from './search.js';
import type { StatusChecker } from './status.js';

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  content: Content[];
  isError?: boolean;
}

interface ToolDef {
  name: string;
  /** Lowest access mode that offers this tool. */
  mode: AccessMode;
  description: string;
  input: z.ZodObject;
  run: (args: any) => Promise<unknown>;
}

const MODE_RANK: Record<AccessMode, number> = { read: 0, write: 1 };
export const allowedIn = (toolMode: AccessMode, serverMode: AccessMode) => MODE_RANK[toolMode] <= MODE_RANK[serverMode];

const folder = z.string().optional().describe("Vault-relative folder to limit results to. Omit for the whole vault.");
const limit = z.number().int().positive().optional().describe('Maximum results to return');
const notePath = z.string().describe("Vault-relative path, e.g. 'Folder/Note.md'");
const date = z.string().describe('Date as YYYY-MM-DD (or an ISO time)');

const isContentResult = (v: unknown): v is ToolResult =>
  typeof v === 'object' && v !== null && Array.isArray((v as ToolResult).content);

export function toolDefs(ops: Ops, status: StatusChecker, mode: AccessMode): ToolDef[] {
  const cfg = ops.cfg;
  const defs: ToolDef[] = [
    {
      name: 'search_notes',
      mode: 'read',
      description: 'Full-text search across notes with ripgrep. Fixed-string matching by default; set regex for a regular expression.',
      input: z.object({
        query: z.string().min(1),
        regex: z.boolean().optional().describe('Treat query as a regular expression'),
        case_sensitive: z.boolean().optional(),
        folder,
        limit,
      }),
      run: async (a) => {
        const max = Math.min(a.limit ?? 50, cfg.searchMaxResults);
        // ripgrep follows a symlink given as its search root, so resolve the folder like any other path.
        let folderRel: string | undefined;
        if (checkRelFolder(a.folder)) {
          const { abs } = await ops.vault.paths.resolveExisting(a.folder);
          if (!(await fs.stat(abs)).isDirectory()) throw new VaultError(`Not a folder: ${a.folder}`);
          folderRel = ops.vault.paths.relOf(abs) || undefined;
        }
        const r = await searchNotes(cfg.rgPath, ops.vault.root, {
          query: a.query,
          regex: a.regex,
          caseSensitive: a.case_sensitive,
          folder: folderRel,
          limit: max,
        });
        return { query: a.query, results: r.hits, truncated: r.truncated };
      },
    },
    {
      name: 'read_note',
      mode: 'read',
      description:
        "Read a note. part: 'full' (raw text plus parsed frontmatter, the default), 'body' (without frontmatter), 'frontmatter', 'outline' (headings), or 'section' (one heading's section). Returns the content hash that replace_in_note needs.",
      input: z.object({
        path: notePath,
        part: z.enum(['full', 'body', 'frontmatter', 'outline', 'section']).optional(),
        heading: z.string().optional().describe("Heading text, for part 'section'"),
      }),
      run: (a) => ops.readNote(a.path, a.part ?? 'full', a.heading),
    },
    {
      name: 'read_image',
      mode: 'read',
      description:
        "Return an image (png, jpeg, gif, webp; SVG comes back as text). Give a vault path, or a note plus the embed's name (e.g. 'diagram.png') or its index among the note's images. Embeds resolve the way Obsidian does.",
      input: z.object({
        path: z.string().optional().describe('Vault-relative path to the image'),
        note: z.string().optional().describe('Note that embeds or links the image'),
        name: z.string().optional().describe('Image name as written in the note'),
        index: z.number().int().min(0).optional().describe('0-based position among the images in the note'),
      }),
      run: async (a) => {
        const img = await readImage(ops.vault, a, cfg.imageMaxBytes);
        if (img.kind === 'svg') {
          return { content: [{ type: 'text', text: `SVG image ${img.path} (${img.bytes} bytes):\n${img.text}` }] };
        }
        return {
          content: [
            { type: 'text', text: `${img.path} (${img.mimeType}, ${img.bytes} bytes)` },
            { type: 'image', data: img.data, mimeType: img.mimeType },
          ],
        };
      },
    },
    {
      name: 'list_notes',
      mode: 'read',
      description: "List notes, optionally inside a folder and/or matching a glob (e.g. '**/*meeting*').",
      input: z.object({ folder, glob: z.string().optional(), limit }),
      run: (a) => ops.listNotes(a.folder, a.glob, a.limit),
    },
    {
      name: 'recent_notes',
      mode: 'read',
      description: 'Notes modified (default) or created on or after a date, newest first.',
      input: z.object({ since: date, field: z.enum(['modified', 'created']).optional(), folder, limit }),
      run: (a) => ops.recentNotes(a.since, a.field ?? 'modified', a.folder, a.limit),
    },
    {
      name: 'stale_notes',
      mode: 'read',
      description: 'Notes not modified since a date, oldest first. Useful for a weekly review.',
      input: z.object({ before: date, folder, limit }),
      run: (a) => ops.staleNotes(a.before, a.folder, a.limit),
    },
    {
      name: 'list_tags',
      mode: 'read',
      description: 'All tags (frontmatter and inline) with note counts. Nested tags appear in full, e.g. project/active.',
      input: z.object({ folder }),
      run: (a) => ops.listTags(a.folder),
    },
    {
      name: 'search_by_tag',
      mode: 'read',
      description: "Notes with a tag. By default also matches nested tags: 'project' matches 'project/active'.",
      input: z.object({ tag: z.string(), include_nested: z.boolean().optional(), folder, limit }),
      run: (a) => ops.searchByTag(a.tag, a.include_nested ?? true, a.folder, a.limit),
    },
    {
      name: 'list_property_keys',
      mode: 'read',
      description: 'All frontmatter property keys with note counts.',
      input: z.object({ folder }),
      run: (a) => ops.listPropertyKeys(a.folder),
    },
    {
      name: 'list_property_values',
      mode: 'read',
      description: 'Values used for one property key, with note counts. List values count once per item.',
      input: z.object({ key: z.string(), folder, limit }),
      run: (a) => ops.listPropertyValues(a.key, a.folder, a.limit),
    },
    {
      name: 'search_by_property',
      mode: 'read',
      description: "Notes whose property matches a value (case-insensitive; list properties match any item), e.g. key 'type', value 'project'. Omit value to find notes that have the key at all.",
      input: z.object({ key: z.string(), value: z.string().optional(), folder, limit }),
      run: (a) => ops.searchByProperty(a.key, a.value, a.folder, a.limit),
    },
    {
      name: 'get_backlinks',
      mode: 'read',
      description: 'Notes that link to this note or file (wikilinks and Markdown links, embeds included).',
      input: z.object({ path: notePath, limit }),
      run: (a) => ops.backlinks(a.path, a.limit),
    },
    {
      name: 'get_outgoing_links',
      mode: 'read',
      description: 'Links in a note (wikilinks and Markdown links) and the vault file each resolves to, or null if unresolved.',
      input: z.object({ path: notePath }),
      run: (a) => ops.outgoingLinks(a.path),
    },
    {
      name: 'find_orphans',
      mode: 'read',
      description: 'Notes that no other note links to.',
      input: z.object({ folder, limit }),
      run: (a) => ops.orphans(a.folder, a.limit),
    },
    {
      name: 'get_daily_note',
      mode: 'read',
      description:
        mode === 'write'
          ? "Get the daily note for a date (default today). If it doesn't exist it is created from the daily note template, unless create_if_missing is false. An existing note is never overwritten."
          : 'Get the daily note for a date (default today). Never creates a note in read-only mode.',
      input: z.object({
        date: z.string().optional().describe('YYYY-MM-DD, default today'),
        ...(mode === 'write' ? { create_if_missing: z.boolean().optional().describe('Default true') } : {}),
      }),
      run: (a) => ops.getDailyNote(a.date, mode === 'write' && a.create_if_missing !== false),
    },
    {
      name: 'read_daily_notes',
      mode: 'read',
      description: 'All existing daily notes between two dates, inclusive.',
      input: z.object({ start: date, end: date, limit }),
      run: (a) => ops.readDailyNotes(a.start, a.end, a.limit),
    },
    {
      name: 'vault_status',
      mode: 'read',
      description: 'Whether the sync service is running, when the vault last changed, the last sync activity, and whether the vault looks stale.',
      input: z.object({}),
      run: () => status.get(true),
    },
    // ---- write mode ----
    {
      name: 'create_note',
      mode: 'write',
      description: `Create a new note. Fails if the note already exists. Give a vault-relative path, or just a title to create it in ${cfg.inboxDir ? `the inbox folder (${cfg.inboxDir})` : 'the vault root'}.`,
      input: z.object({
        path: z.string().optional(),
        title: z.string().optional(),
        content: z.string(),
        properties: z.record(z.string(), z.unknown()).optional().describe('Frontmatter properties to add'),
      }),
      run: (a) => ops.createNote(a),
    },
    {
      name: 'append_to_note',
      mode: 'write',
      description: "Append text to the end of a note, or to the end of a heading's section.",
      input: z.object({ path: notePath, content: z.string(), heading: z.string().optional() }),
      run: (a) => ops.appendToNote(a.path, a.content, a.heading),
    },
    {
      name: 'replace_in_note',
      mode: 'write',
      description: "Replace text that appears exactly once in a note. Needs the note's current hash from read_note so stale edits are refused.",
      input: z.object({ path: notePath, old_text: z.string(), new_text: z.string(), expected_hash: z.string() }),
      run: (a) => ops.replaceInNote(a.path, a.old_text, a.new_text, a.expected_hash),
    },
    {
      name: 'update_properties',
      mode: 'write',
      description: 'Set or remove frontmatter properties. Every other key, the key order and YAML comments are kept.',
      input: z.object({
        path: notePath,
        set: z.record(z.string(), z.unknown()).optional(),
        unset: z.array(z.string()).optional(),
        expected_hash: z.string().optional(),
      }),
      run: (a) => ops.updateProperties(a.path, a.set, a.unset, a.expected_hash),
    },
  ];
  return defs;
}

export function registerTools(server: McpServer, ops: Ops, status: StatusChecker, mode: AccessMode) {
  for (const def of toolDefs(ops, status, mode)) {
    if (!allowedIn(def.mode, mode)) continue;
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.input,
        annotations: { readOnlyHint: def.mode === 'read', destructiveHint: false, openWorldHint: false },
      },
      (async (args: unknown) => runTool(def, args, status, mode)) as never,
    );
  }
}

export async function runTool(def: ToolDef, args: unknown, status: StatusChecker, mode: AccessMode): Promise<ToolResult> {
  let result: ToolResult;
  // Second check, independent of registration: never run a tool outside the server's mode.
  if (!allowedIn(def.mode, mode)) {
    result = { content: [{ type: 'text', text: `Tool ${def.name} is not available in ${mode} mode` }], isError: true };
  } else {
    try {
      const out = await def.run(args ?? {});
      result = isContentResult(out) ? out : { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (e) {
      const safe = e instanceof VaultError || e instanceof ConfigError;
      const msg = safe ? (e as Error).message : 'Internal error';
      if (!safe) console.error(`tool ${def.name} failed:`, e);
      result = { content: [{ type: 'text', text: msg }], isError: true };
    }
  }
  const warning = await status.warning().catch(() => null);
  if (warning) result.content.unshift({ type: 'text', text: warning });
  return result;
}
