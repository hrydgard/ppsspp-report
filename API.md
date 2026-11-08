# report.ppsspp.org JSON API

Read-only JSON over the same data as the `/logs` pages. Base URL: `https://report.ppsspp.org/api/v1`. No key needed.
`GET /api/v1` describes the endpoints and terms too. Add `pretty=1` to any request for indented JSON.

## What the data is

PPSSPP builds (v1.19.0 and newer; older reports are dropped) send log messages when something unusual happens in a game.

- A **kind** is the message template, the format string in the PPSSPP source, e.g. kind 967
  `Error in shader program link: info: %s\nfs: %s\n%s\nvs: %s\n%s`. Search the PPSSPP source for the template to find where it's logged.
- A **message** is one stored row per (kind, game, exact text). The same text from the same game is stored once; repeat reports
  only increase hit counters per version, platform, GPU, CPU and config.
- **hits** = reports summed over versions. Each per-version counter stops at 65,535, so very common messages are undercounted.
- **status** is `new`, `resolved` or `reoccurring`. "Resolved" was set by hand with a "fixed in version" value; if the message is
  reported again from that version or newer it becomes `reoccurring`. Lists default to `new` + `reoccurring`; `status=any` shows all.
- **text_truncated**: texts are cut at 4,096 characters when stored. Long shader sources often are.

## Endpoints

| Endpoint | What |
|---|---|
| `GET /kinds` | Kinds with unresolved messages (or per `status`): id, template, blocked, games. `min_version`: only kinds reported from that version or newer |
| `GET /kinds/:id` | One kind and its message count |
| `GET /kinds/:id/groups` | Distinct texts of a kind with games, messages, hits, latest report, most hits first; 100 per page (`page`, `next`) |
| `GET /kinds/:id/messages` | Full messages, newest first: text, game, status, hits, first/latest report, and the 10 most recent versions, platforms, GPUs (with driver string) and CPUs, each with totals. `limit` (default 25, max 100), `next` link for the following page |
| `GET /messages/:id` | One message with everything, plus the PPSSPP settings of the 3 most recent configs it was reported with |

Filters (kinds/:id/groups and kinds/:id/messages):

| Param | Meaning |
|---|---|
| `min_version` | `v1.20.4` or `1.20.4`: only reports from this version or newer. Dev builds after a release (`v1.20.4-605-g...`) count as newer. |
| `max_version` | Upper bound, inclusive; its dev builds count as newer, so `max_version=v1.20.4` excludes `v1.20.4-605-g...` |
| `since` | `YYYY-MM-DD`: only messages reported (from those versions) on or after that date |
| `status` | `new`, `resolved`, `reoccurring`, `any` |
| `text` | exact message text (messages only); the `messages_url` of each group uses it |

## Writing: resolve

`POST /api/v1/resolve` marks messages as fixed. It needs the shared secret: `Authorization: Bearer <secret>` (ask the server
owner; it's `REPORT_API_SECRET` in the server's `config`). JSON body:

| Field | Meaning |
|---|---|
| `kind` | required: kind id |
| `version` | required: the version the fix is in, e.g. `v1.20.5`, or a dev build `v1.20.4-2100-gabcdef` |
| `text` / `message` | optional: only messages with this exact text, or only this message id (not both) |
| `dry_run` | optional `true`: only count, change nothing |

Only open messages are touched (`new`, or `reoccurring` resolved at an older version). Messages already reported from a version
**newer** than `version` are skipped and counted in `skipped_seen_in_newer_version`: the fix evidently didn't cover them. A resolved
message that is reported again from `version` or newer becomes `reoccurring` automatically, and shows up in the default lists again.

    curl -X POST https://report.ppsspp.org/api/v1/resolve -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
         -d '{"kind": 967, "version": "v1.20.5", "dry_run": true}'

Errors are JSON `{"error": "..."}` with 400 (bad parameter), 401 (missing or wrong secret), 404 (no such kind/message), 503 (query took over 10 s, or writes not enabled).

## Example: shader compile/link failures

    GET /api/v1/kinds/967/groups?min_version=v1.20.4          # what's still failing in recent builds, by text
    GET /api/v1/kinds/967/messages?min_version=v1.20.4&limit=10   # full shader sources, GPUs and drivers
    GET /api/v1/messages/2791541                               # one message with the settings it was reported with

A shader message's text holds the driver's info log first, then the fragment shader (`fs:`) and vertex shader (`vs:`) sources.
`gpus.recent[].driver` is the GL/Vulkan driver string. Things to look at: which GPUs/drivers fail (`gpus`), whether it still happens in
current builds (`versions.recent`), and how widespread it is (`hits`, `games` in groups).
