# report.ppsspp.org JSON API

JSON over the same data as the `/logs` pages. Base URL: `https://report.ppsspp.org/api/v1`. Reading needs no key; the two write
endpoints need the shared secret. `GET /api/v1` describes the endpoints and terms too. Add `pretty=1` to any GET for indented JSON.

**Send your own User-Agent** (e.g. `ppsspp-report-agent/1.0`): Cloudflare blocks some default ones, like Python's `urllib`
(`Python-urllib/3.x` gets 403).

## What the data is

PPSSPP builds (v1.19.0 and newer; older reports are dropped) send log messages when something unusual happens in a game.

- A **kind** is the message template, the format string in the PPSSPP source, e.g. kind 967
  `Error in shader program link: info: %s\nfs: %s\n%s\nvs: %s\n%s`. Search the PPSSPP source for the template to find where it's logged.
- A **message** is one stored row per (kind, game, exact text). The same text from the same game is stored once; repeat reports
  only increase hit counters per version, platform, GPU, CPU and config. A text that differs by one character (another shader ID,
  another address) is a different message.
- **hits** = reports summed over versions. Each per-version counter stops at 65,535, so very common messages are undercounted.
- **text_truncated**: texts are cut at 4,096 characters when stored. Long shader sources often are.
- **Versions** order by release, then commit count: `v1.20.4` < `v1.20.4-605-gabc` < `v1.20.5`. Dev and beta builds work everywhere a
  version is taken.

### Status

| Status | Meaning | Reopens (becomes `reoccurring`) when |
|---|---|---|
| `new` | open | - |
| `resolved` | fixed in `fixed_version` | the same message (kind, game, exact text) is reported from `fixed_version` or newer |
| `ignored` | won't fix, or pruned | only if it was ignored *as of* a version, and is then reported from that version or newer (the pruning didn't work) |
| `reoccurring` | was resolved/ignored, came back | - |

Lists default to `new` + `reoccurring`, so resolved and ignored messages drop out. `status=any` shows everything. Messages carry
`fixed_version`, `fixed_version_value`, `note` and `resolved_at`. Resolutions made before 2026-11-08 have only `fixed_version_value`.

## Reading

| Endpoint | What |
|---|---|
| `GET /kinds` | Kinds with unresolved messages (or per `status`): id, template, blocked, games. `min_version`: only kinds reported from that version or newer |
| `GET /kinds/:id` | One kind and its message count |
| `GET /kinds/:id/groups` | Distinct texts of a kind with games, messages, hits, latest report, `latest_version`; most hits first; 100 per page (`page`, `next`) |
| `GET /kinds/:id/messages` | Full messages, newest first: text, game, status details, hits, first/latest report, `latest_version`, and the 10 most recent versions, platforms, GPUs (with driver string) and CPUs, each with totals. `limit` (default 25, max 100), `next` link for the following page |
| `GET /messages/:id` | One message with everything, plus the PPSSPP settings of the 3 most recent configs it was reported with |
| `GET /messages/:id/reports` | The message's individual reports, newest first (see below). `before` cursor, `next` link |
| `GET /reports` | The newest individual reports of all messages as they came in, repeats included; each also has `kind`, `game`, `text_start` (first 400 characters) and `status` |
| `GET /stats` | Ingest counters: per hour and outcome, how many reports were stored or dropped and why |

Filters (`/kinds/:id/groups` and `/kinds/:id/messages`):

| Param | Meaning |
|---|---|
| `min_version` | `v1.20.4` or `1.20.4`: only reports from this version or newer |
| `max_version` | upper bound, inclusive; `max_version=v1.20.4` excludes `v1.20.4-605-g...` (newer) |
| `since` | `YYYY-MM-DD`: only messages reported (from those versions) on or after that date |
| `status` | `new`, `resolved`, `reoccurring`, `ignored`, `any` |
| `fixed_version` | only messages resolved/ignored at exactly this version, to check what you closed |
| `text` | exact message text (messages only); each group's `messages_url` uses it |

`latest_version` is the highest version that reported the text, so "does it still happen in the newest beta?" needs no message fetch.

### Individual reports

Since 2026-11-12 every stored report is also kept on its own, the newest 100 per message (the counters above still count all
of them). Each has `reported_at`, `version`, `platform`, `gpu`, `cpu`, `settings` (non-default PPSSPP settings), and what the app
sent with it: `seconds_played` (emulated seconds since the game booted; newer builds), `ticks` (emulated CPU cycles, a string),
`fps`, `vps`, `savestate_used`, `pixel_width`/`pixel_height`, `sdkver`, `module_ver`, `firmware`, `file_type`, `disc_container`,
`os`, `os_build`, `device_model`. Fields a build doesn't send are `null` or `""`. Same data in HTML: `/logs/message/:id`
(the Hits number on the `/logs` pages links there) and `/logs/all`.

## Writing

Both endpoints need `Authorization: Bearer <secret>` (one shared secret; ask the server owner), over https, in a POST with a JSON
(or form) body. Every write is logged on the server. Repeating a call is harmless: messages already in the requested state are
reported as `unchanged`. Do a `dry_run` first.

### `POST /resolve`

| Field | Meaning |
|---|---|
| `action` | `resolve` (default), `ignore` or `reopen` (back to `new`) |
| `messages` | list of message ids (up to 1000), e.g. all messages of one cause; the response has a result per id. Or a single `message` |
| `kind` | instead of ids: the open (`new`/`reoccurring`) messages of a kind, optionally narrowed by `text` (exact) |
| `gpu` | instead of or with `kind`: only messages reported *exclusively* from GPUs whose name contains this (case-insensitive; unnamed GPUs don't count), e.g. `Mali-4` for Mali-400/450/470. Without `kind` it covers all kinds |
| `fixed_version` | with `kind`/`gpu`: narrow to messages resolved/ignored at exactly this version (needed, or `text`/`gpu`, to `reopen` a kind) |
| `version` | the fixed-in version, e.g. `v1.20.5` or `v1.20.4-4634-g9f286ee`. Required for `resolve`; optional for `ignore` (ignore as of a version, so it reopens if it still comes from newer builds); not for `reopen` |
| `note` | free text, e.g. the commit or PR (up to 1024 characters) |
| `dry_run` | `true`: report what would change, change nothing |
| `force` | `true`: also change messages already reported from `version` or newer (normally skipped as `skipped_seen_in_version`: the fix evidently didn't cover them) |

With `kind`/`gpu`, only open messages are changed; resolved/ignored ones keep their version and note (pass their ids to change
them). The response then has totals plus `by_kind`. With `messages`, each id gets a `result`: `resolved` / `ignored` / `reopened`
(or `would_be_...` in a dry run), `unchanged`, `skipped_seen_in_version` (with `seen_version`), `not_found`.

    curl -X POST https://report.ppsspp.org/api/v1/resolve -A ppsspp-report-agent/1.0 \
         -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
         -d '{"messages": [2791541, 2791540], "version": "v1.20.4-516-gb68d4c0c48", "note": "b68d4c0c48", "dry_run": true}'

    # Mali-400/450 only, everywhere, won't fix:
    -d '{"action": "ignore", "gpu": "Mali-4", "note": "Mali-400 not supported", "dry_run": true}'

### `POST /kinds/:id/block`

`{"blocked": true}` drops all new reports of the kind (they're accepted but not stored); `{"blocked": false}` undoes it. Takes
effect immediately. Already stored messages stay.

## Errors

JSON `{"error": "..."}` with 400 (bad parameter), 401 (missing or wrong secret), 404 (no such kind/message), 503 (query took too
long, or writes not enabled).

## Example: shader compile/link failures

    GET /api/v1/kinds/967/groups?min_version=v1.20.4             # what's still failing in recent builds, by text
    GET /api/v1/kinds/967/messages?min_version=v1.20.4&limit=10  # full shader sources, GPUs and drivers
    GET /api/v1/messages/2791541                                 # one message with the settings it was reported with

A shader message's text holds the driver's info log first, then the fragment shader (`fs:`) and vertex shader (`vs:`) sources.
`gpus.recent[].driver` is the GL/Vulkan driver string. Things to look at: which GPUs/drivers fail (`gpus`), whether it still happens in
current builds (`latest_version`), and how widespread it is (`hits`, `games` in groups).
