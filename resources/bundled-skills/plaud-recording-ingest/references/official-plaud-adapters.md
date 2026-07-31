# Official PLAUD Adapter Contract

Use this reference when choosing between the official PLAUD MCP and CLI.

## Supported official surfaces

PLAUD documents two separate local packages:

- `@plaud-ai/mcp`: OAuth and MCP tools for Codex, Claude Code, Claude Desktop,
  Cursor, Windsurf, VS Code, Zed, and web clients.
- `@plaud-ai/cli`: terminal access for account state, recording discovery,
  metadata, audio URLs, existing PLAUD transcripts, and existing PLAUD notes.

Official documentation:

- <https://docs.plaud.ai/plaud-mcp-cli/mcp>
- <https://docs.plaud.ai/plaud-mcp-cli/cli>

Pin versions in a product build and upgrade deliberately. The versions verified
on 2026-07-31 were MCP `0.3.7` and CLI `0.3.6`.

## Local-first tool policy

Use the official tools according to this matrix:

| Need | Preferred surface | Model-visible result |
|---|---|---|
| Sign in | MCP `login` or CLI `plaud login` | status only |
| Verify account | captured MCP or CLI adapter | redacted account status |
| Browse or search | MCP `list_files` | minimum recording metadata |
| Download audio | bundled CLI downloader | path, bytes, hash, format |
| Local transcript | bundled MLX wrapper | path, counts, hashes |
| PLAUD transcript | MCP `get_transcript` or CLI `transcript` | explicit opt-in only |
| PLAUD summary | MCP `get_note` or CLI `summary` | explicit opt-in only |

The default path must never invoke a PLAUD transcript or note tool. Reading an
already generated PLAUD artifact is still a distinct content route and must be
reported as such even when no new allowance appears to be consumed.

## MCP content firewall

The official MCP `get_file` response includes:

- a temporary `presigned_url`;
- transcript structures in `source_list`;
- PLAUD generated notes in `note_list`.

Do not expose this raw response to an online chat model. In Command EVE, call it
only behind the native content firewall and strip these fields before returning
a receipt. Outside Command EVE, use the safe CLI downloader, which captures the
signed URL locally and never prints it.

The official MCP package also ships broad skills such as `plaud-read`,
`plaud-digest`, `plaud-followup`, and `plaud-export`. Those skills prefer PLAUD
notes or transcripts and may expose a signed URL or deliver content externally.
For local-first work, this skill takes precedence. Do not chain into an official
export skill without the user's explicit destination and action approval.

## Installation modes

For a general local AI client, PLAUD documents:

```bash
npx -y @plaud-ai/mcp@<pinned-version> install
```

The installer can configure supported clients and opens the official OAuth
flow. A product build must not use `@latest`; manage a verified version.

Command EVE should package or install the MCP server as a managed dependency,
but expose only the scoped source adapter defined above. Do not install the
official broad skills into the default EVE catalog without a separate safety
review.

Claude Code and Codex may use the same portable `plaud-recording-ingest` skill.
Keep the Company.OS authoring copy canonical, validate it once, and install
deterministic full-tree copies into each client's user skill directory. Do not
depend on cross-client symlinks: packagers and signed application runtimes may
skip them.

## Authentication and telemetry

- Let the official browser OAuth flow manage tokens.
- Never inspect, copy, log, or request `~/.plaud/tokens.json` or
  `~/.plaud/tokens-mcp.json`.
- Use `PLAUD_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` for every non-login CLI
  subprocess controlled by this skill.
- Do not assume that CLI and MCP authentication are shared; PLAUD documents
  separate token stores.

## Readiness truth

Do not infer audio absence solely from `plaud file`. The authoritative local
test is whether the safe `plaud audio` path returns a valid, verified audio
artifact. Web playback is also strong user-visible evidence that audio exists
in the account.
