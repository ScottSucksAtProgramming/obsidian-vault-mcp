# obsidian-vault-mcp

A small, auditable [MCP](https://modelcontextprotocol.io) server that gives an AI client (such as Claude) access to an Obsidian vault. It works directly on the Markdown files on disk, so Obsidian doesn't need to be running. It is meant to run on a small Linux server or container next to [Obsidian Sync's headless client](https://www.npmjs.com/package/obsidian-headless), behind a tunnel or proxy that handles user sign-in.

It is read-only by default. A `write` mode adds tools that create and edit notes. A `full` mode also adds tools that move, rename and delete notes. Delete only moves a note to the vault's `.trash` folder.

## Access modes

Set `ACCESS_MODE` before anything else. It decides which tools the server offers.

| Mode | What the client can do |
|---|---|
| `read` (default) | Search and read notes, images, tags, properties, links and daily notes. Check sync status. Nothing on disk changes. |
| `write` | Everything in `read`, plus `create_note`, `append_to_note`, `replace_in_note`, `update_properties`, and creating today's daily note from your template when it doesn't exist. |
| `full` | Everything in `write`, plus `move_note`, `rename_note`, `move_folder` and `delete_note`. See [Full-mode tools](#full-mode-tools). |

The server enforces the mode itself. Tools above the configured mode are not registered. For example, in `read` mode the write tools are not registered, so they don't appear in `tools/list`, and a `tools/call` for one is refused whatever the client sends. A second check inside the tool runner refuses any tool above the configured mode.

## Tools

Read tools (every mode):

| Tool | What it does |
|---|---|
| `search_notes` | Full-text search with ripgrep. Fixed-string by default, optional regex, case-sensitivity, folder filter and result limit. |
| `read_note` | A note's full text with parsed frontmatter, or just the body, the frontmatter, the outline (headings), or one heading's section. Returns a content hash. |
| `read_image` | An image by vault path, or one embedded or linked in a note (`![[name.png]]` resolved by shortest matching path, `![](relative/path.png)` from the note's folder). PNG, JPEG, GIF and WebP come back as MCP image content, with the type detected from the file's bytes. SVG comes back as text. Files over `IMAGE_MAX_BYTES` are refused. |
| `list_notes` | Notes in a folder and/or matching a glob. |
| `recent_notes` | Notes modified (or created) since a date. |
| `stale_notes` | Notes not modified since a date, for a weekly review. |
| `list_tags` | Every tag with a note count, frontmatter and inline, nested tags in full. |
| `search_by_tag` | Notes with a tag. `project` also matches `project/active` unless you turn nesting off. |
| `list_property_keys` | Every frontmatter key with a note count. |
| `list_property_values` | The values used for one key, with counts. |
| `search_by_property` | Notes where a key has a value, for example `type: project`. |
| `get_backlinks` | Notes that link to a note or file. |
| `get_outgoing_links` | Wikilinks and Markdown links in a note, and the file each one resolves to. |
| `find_orphans` | Notes that no other note links to. |
| `get_daily_note` | The daily note for a date. In `write` mode it is created from your template if missing. It always checks for an existing note first and never overwrites one. |
| `read_daily_notes` | All daily notes in a date range. |
| `vault_status` | Whether the sync service is running, when the vault last changed, the last sync activity, and a stale flag. |

Write tools (`write` mode only):

| Tool | What it does |
|---|---|
| `create_note` | Creates a note at a path, or in `INBOX_DIR` when given only a title. Fails if the note exists. Can add frontmatter properties. |
| `append_to_note` | Appends text to the end of a note, or to the end of a named heading's section. |
| `replace_in_note` | Replaces text that must match exactly once. The client must send the note's current hash (from `read_note`), so an edit based on an old copy is refused. |
| `update_properties` | Sets or removes frontmatter keys. Every other key, the key order and YAML comments stay as they were. |

### Full-mode tools

These are available only in `full` mode. MCP clients see them marked as destructive.

| Tool | What it does |
|---|---|
| `move_note` | Moves a note to another folder and keeps its file name. Creates the folder if needed. |
| `rename_note` | Renames a note in its folder. |
| `move_folder` | Moves or renames a folder with everything in it. |
| `delete_note` | Moves a note to the vault's `.trash` folder, where Obsidian keeps deleted files. Nothing is deleted permanently. If `.trash` already has a note with that name, the new one gets a number (`Note 2.md`). Links to the deleted note are left as they are. |

Rules for all four:

- They never overwrite. If anything already exists at the destination, the tool refuses.
- They refuse paths outside the vault, anything in a dot folder (`.obsidian`, `.trash`, `.git`), symlinks, and anything in `READONLY_DIRS`. A folder that contains a read-only folder can't be moved either. New names can't use characters that break wikilinks (`* " \ / < > : | ? # ^ [ ]`) or start with a dot.
- Before each change, the server runs the snapshot script at `SNAPSHOT_PATH` (default `/usr/local/bin/vault-snapshot`) with one argument, `Before <tool> <path>`, from the vault folder. The script is expected to commit the vault to git so the change can be rolled back. If the script isn't installed, the change goes ahead and the result says the snapshot was skipped. If it is installed but fails, the change is refused and nothing on disk changes. Refused calls never run the script.
- Links are kept working. After `move_note`, `rename_note` or `move_folder`, the server checks every wikilink, embed and Markdown link in the vault. Any link that pointed at the moved files and would now point somewhere else (or nowhere) is rewritten. The rewrite keeps `!`, `#heading`, `|alias` and the `.md` extension as they were written. Links that still resolve, such as `[[Note]]` after a move, are left alone. Links that were already broken are left alone.
- The result lists the notes whose links changed (`links_updated`) and any it could not fix (`links_not_updated`): notes in read-only folders, notes over `READ_MAX_BYTES`, and links that would be ambiguous in every form.
- Only one full-mode change runs at a time. Each one writes a `move` or `delete` JSON line to the log, plus a `write` line for every note whose links were rewritten.
- `move_note`, `rename_note` and `move_folder` are safe to retry. A client can lose the connection after the server has finished a move, then send the same call again. If the source is gone and the destination still has exactly what this server moved there, the retry succeeds without changing anything. Its result has `already_done: true`, a `note` saying so, and the link report from the first call. The server remembers its last 200 moves in memory only, so a retry after a restart gets the normal "Not found" error. If the destination has changed since the move, the retry also gets "Not found".
- Each move writes a `timing` JSON line with the milliseconds spent in each step: `walk` (listing the vault), `plan` (finding notes whose links need changing), `snapshot`, `move`, `links` (rewriting them) and `total`. The line also gives `notes_scanned` and `notes_to_fix`. Notes are read once and kept in memory, and later moves re-read only notes whose size or modified time changed. In `full` mode the server reads every note at startup and logs a `warm_link_index` timing line when it's done.

### Daily notes

The server reads the Daily Notes core plugin's settings from `<vault>/.obsidian/daily-notes.json` (fields `folder`, `format` and `template`). This file is the only thing it reads inside a dot folder, and no tool exposes it. Obsidian leaves fields out of that file when they're at their defaults, so any missing field falls back to `DAILY_DIR`, `DAILY_FORMAT` or `DAILY_TEMPLATE`, then to Obsidian's defaults (vault root, `YYYY-MM-DD`, no template). The format uses [Moment.js tokens](https://momentjs.com/docs/#/displaying/format/), as Obsidian does. Templates can use `{{date}}`, `{{time}}`, `{{title}}`, `{{date:FORMAT}}` and `{{time:FORMAT}}`.

"Today" uses the server's time zone. Set `TZ` in the env file if the host runs on UTC and you don't.

### Stale warning

If the sync unit isn't active, or the newest file change in the vault is older than `STALE_HOURS`, every tool result starts with a one-line warning saying the vault may be out of date. The check is cached for a minute.

Last sync activity comes from the log that `ob sync` writes (`sync/<vault id>/sync.log` in ob's config folder). The server reads only that log's last line. It never opens ob's `config.json` or auth token.

## Security model

- **Bearer auth on every request.** Every HTTP request must carry `Authorization: Bearer <MCP_TOKEN>`. The server hashes both values and compares them in constant time. Anything else gets a 401. The token must be at least 32 characters.
- **Loopback only.** The server binds to `127.0.0.1`. Put a tunnel or reverse proxy in front of it. Requests with a `Host` header not in `ALLOWED_HOSTS` get a 403, which blocks DNS-rebinding attacks from a browser.
- **Delete, move and rename only in `full` mode.** Delete moves the note to `.trash`. Every full-mode change runs the snapshot script first and is refused if the script fails.
- **Path safety.** Every path is vault-relative. The server rejects absolute paths, `..`, and any dot-prefixed segment (`.obsidian`, `.trash`, `.git`). It resolves the real path and refuses anything outside the vault, including symlinks that lead out or into a dot folder. Writes only go to `.md` files, never through a symlink, and never inside `READONLY_DIRS`.
- **Safe writes.** Writes go to a temp file and are renamed into place. New notes are created with a hard link, which fails if the file already exists, so a create can never overwrite. One lock per file stops overlapping edits from this server. Reads and writes have size limits.
- **Write log.** Every write logs the tool, path, byte count and SHA-256 to stdout as one JSON line, so journald keeps an audit trail.
- **No shell, no outbound network.** ripgrep and systemctl run with `execFile` and an argument array. The server makes no network calls of its own.
- **Error messages** use vault-relative paths and never include host paths or stack traces.
- **Local-only search** (planned). The semantic search in the roadmap runs a local embedding model with no outside APIs.

## Requirements

- Node.js 22 or later
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`apt install ripgrep`)
- Linux with systemd for the sync check (the server runs elsewhere too, but `vault_status` will report the unit as `unknown`)

## Setup

```sh
git clone https://github.com/<you>/obsidian-vault-mcp.git /opt/obsidian-vault-mcp
cd /opt/obsidian-vault-mcp
npm ci --ignore-scripts
npm run build

sudo mkdir -p /etc/obsidian-vault-mcp
sudo cp .env.example /etc/obsidian-vault-mcp/env
sudo chown vault:vault /etc/obsidian-vault-mcp/env
sudo chmod 600 /etc/obsidian-vault-mcp/env
sudoedit /etc/obsidian-vault-mcp/env          # set VAULT_DIR and MCP_TOKEN at least
```

Generate a token with `openssl rand -hex 32`. The client (or the proxy in front of the server) sends it as a bearer token.

## Configuration

All settings come from environment variables. `.env.example` lists every one with a placeholder.

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_DIR` | required | Absolute path to the vault. |
| `MCP_TOKEN` | required | Bearer token, 32+ characters. |
| `PORT` | `8787` | Port on 127.0.0.1. |
| `ACCESS_MODE` | `read` | `read`, `write` or `full`. |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1` | Accepted `Host` header names. Add your tunnel's public hostname if requests arrive with it. |
| `READONLY_DIRS` | empty | Comma-separated vault-relative folders that are never written. |
| `INBOX_DIR` | vault root | Folder for notes created with only a title. |
| `DAILY_DIR`, `DAILY_FORMAT`, `DAILY_TEMPLATE` | empty, `YYYY-MM-DD`, empty | Fallbacks for the Daily Notes settings. |
| `TZ` | system | Time zone for "today". |
| `SYNC_UNIT` | `obsidian-sync` | systemd unit to check. Empty turns the check off. |
| `OB_CONFIG_DIR` | ob's default | Where `ob` keeps its state (`~/.config/obsidian-headless` on Linux). |
| `STALE_HOURS` | `24` | Age of the newest change that triggers the stale warning. |
| `IMAGE_MAX_BYTES` | `5242880` | Largest image `read_image` returns. |
| `READ_MAX_BYTES` | `1048576` | Largest note the server reads. |
| `WRITE_MAX_BYTES` | `1048576` | Largest note the server writes. |
| `SEARCH_MAX_RESULTS` | `200` | Cap on search results. |
| `RG_PATH`, `SYSTEMCTL_PATH` | `rg`, `systemctl` | Paths to those programs. |
| `SNAPSHOT_PATH` | `/usr/local/bin/vault-snapshot` | Script run before every full-mode change. Skipped if missing; a failure refuses the change. |

Folder names are never hardcoded. Every folder the server treats specially comes from these settings or from Obsidian's own daily-notes settings.

## Running with systemd

Both units are in [`deploy/`](deploy/). Adjust paths to match your system. `command -v ob` and `command -v node` give the right `ExecStart` paths.

`/etc/systemd/system/obsidian-vault-mcp.service`:

```ini
[Unit]
Description=obsidian-vault-mcp (MCP server for an Obsidian vault)
After=network.target obsidian-sync.service

[Service]
Type=simple
User=vault
Group=vault
WorkingDirectory=/opt/obsidian-vault-mcp
# chmod 600, owned by vault. Holds MCP_TOKEN, so keep it unreadable by other users.
EnvironmentFile=/etc/obsidian-vault-mcp/env
ExecStart=/usr/bin/node /opt/obsidian-vault-mcp/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/vault/vault
# ...more hardening in deploy/obsidian-vault-mcp.service

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/obsidian-sync.service`, running Obsidian Sync continuously as the same user:

```ini
[Unit]
Description=Obsidian Sync (obsidian-headless, continuous)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vault
Group=vault
WorkingDirectory=/home/vault/vault
ExecStart=/usr/bin/ob sync --continuous
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-sync obsidian-vault-mcp
journalctl -u obsidian-vault-mcp -f      # start line, write log, errors
```

`systemctl is-active` works without root, so the `vault` user can check the sync unit.

## Container hardening

If you run this in a container next to the sync client, these steps keep the vault and your credentials safe:

- Use an **unprivileged LXC** container (or equivalent), not a privileged one.
- Allow **SSH keys only**. Set `PasswordAuthentication no` and `PermitRootLogin no` in `sshd_config`.
- Turn on **unattended-upgrades** for security updates.
- Run both services as a dedicated `vault` user. Make **ob's config folder** (`~/.config/obsidian-headless`, which holds the Obsidian auth token and vault encryption key) and the **env file** readable only by that user: `chmod 700` on the folder, `chmod 600` on the files.
- Keep **encrypted backups** of the vault (for example restic or borg with a passphrase stored off the host). Sync is not a backup.
- Expose the server only through an authenticated tunnel or proxy. Never open its port to the internet.

## Development

```sh
npm ci --ignore-scripts
./check           # typecheck, tests, gitleaks scan
```

Tests run against a synthetic fixture vault in `tests/fixtures/vault`, copied to a temp folder for each test. They never touch a real vault.

Secret scanning: `git config core.hooksPath .githooks` turns on a gitleaks pre-commit hook. CI runs gitleaks over the full history on every push.

## Future work

- **Local semantic search:** hybrid keyword and meaning search with a small local embedding model and a SQLite index, plus related-notes suggestions. No outside APIs.

## License

[MIT](LICENSE)
