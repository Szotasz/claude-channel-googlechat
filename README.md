# claude-channel-googlechat

A [Claude Code](https://claude.com/claude-code) **channel plugin** for **Google
Chat** (Google Workspace). It bridges a Claude Code session to Google Chat over
**Cloud Pub/Sub** (works behind a firewall — no public URL, tunnel, or TLS cert),
with **identity-based access control** keyed on verified Workspace emails.

It is a structural sibling of the official Telegram/Discord channel plugins:
inbound messages arrive as `<channel>` blocks; you reply with MCP tools
(`reply`, `react`, `edit_message`, `download_attachment`). The differences are
the transport (Pub/Sub instead of long-poll) and the gate (Workspace identity
instead of pairing codes).

```
Google Chat  ──(event)──▶  Pub/Sub topic  ──(pull)──▶  this plugin  ──▶  Claude Code session
     ▲                                                      │
     └──────────────── Chat REST API (reply) ◀──────────────┘
```

## Why Google Chat (vs Telegram/Slack)

- **Verified identity.** Every message carries the sender's Workspace identity,
  so the plugin gates on real emails and assigns an **owner/user** role — ideal
  when one privileged operator oversees several company users.
- **Already paid for.** If your org runs Google Workspace, Chat is included; no
  extra per-seat cost, no second identity island, IT-managed, SSO, offboarding.

## Install

```bash
# add the marketplace, then enable the plugin
claude plugin marketplace add <owner>/claude-channel-googlechat
claude plugin enable googlechat@claude-channel-googlechat

# launch a session bound to this channel
claude --channels plugin:googlechat@claude-channel-googlechat
```

Requires [bun](https://bun.sh). Dependencies install on first run.

## Setup

1. Do the one-time **GCP / Workspace setup** — see [SETUP.md](./SETUP.md).
2. Configure the plugin: `/googlechat:configure` (saves the service-account key,
   project, subscription) and `/googlechat:access owner you@company.com`.
3. Relaunch and DM the app from your owner account — the message lands in your
   session.

## Access model

Identity-based, no pairing. Default is **drop-all** until configured. Managed via
`/googlechat:access` (allow emails, allow a domain, set owner/roles, opt spaces
in). Full reference: [ACCESS.md](./ACCESS.md).

The `meta.role` field on each inbound message is `owner` or `user` — your agent
can branch on it (e.g. give the owner full scope and company users a limited one).

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Send a message to a space; threads via `reply_to` (the inbound thread name or message name); a `reply_to` that cannot be placed is an error, nothing is sent; attaches `files` (best-effort upload). |
| `react` | Add an emoji reaction. **Best-effort** — app reactions are restricted in many Workspace configs. |
| `edit_message` | Edit one of the bot's own messages (interim progress). Not chunked. |
| `download_attachment` | Download an uploaded attachment to the local inbox. (Drive-file attachments unsupported in v1.) |
| `local_history` | What this bot itself saw of a thread, from a local log (see below). Not the full thread. Off, and not listed, until the operator switches it on. |

## Local history

This plugin does not read a thread back from Google: it only sees messages as
they arrive. An agent that lost its context (a restart, a long conversation)
could therefore not re-read what it was answering. So the plugin can keep a
small log of its own.

**It is off by default.** Switched on, it writes the text of other people's
messages to this machine's disk, and that is the operator's decision to make,
not something an update should start doing. To switch it on, set
`GOOGLECHAT_HISTORY_DAYS` (for example `14`) in the channel's `.env` and restart
the channel. While it is off nothing is written, the `local_history` tool is not
listed, and an install behaves as it did before this feature existed.

Once on:

- **What is in it:** the inbound messages that passed the access gate and were
  delivered, and the messages the bot sent with `reply` (and their edits).
- **What is not:** messages the bot was not mentioned in, messages the gate
  dropped, anything from before the log existed or while the server was down,
  and edits or deletions made by people. `local_history` says this to the model
  on every call, so it does not read a gap as "nobody said that".
- **How it is read:** one thread at a time (`thread` is the inbound
  `meta.thread` or `meta.message_id`). A named space is never returned whole; a
  direct message needs no thread. Only spaces the bot may write to can be read.
- **Where it lives:** `history/log.jsonl` under the state dir, directory `0700`,
  file `0600`. It holds message text. It cannot be sent as an attachment.
- **How long:** as many days as `GOOGLECHAT_HISTORY_DAYS` says (at most 90),
  and at most 5 MB by default (`GOOGLECHAT_HISTORY_MAX_MB`), the oldest records
  going first. Both bounds are enforced on disk at start, every hour and on writes,
  and an expired record is never returned in between. While the server is not
  running nothing is removed: the file is trimmed at the next start.
- **Switching it off again:** remove `GOOGLECHAT_HISTORY_DAYS` or set it to `0`.
  Nothing is written, the tool is not listed, and an existing log is deleted at
  the next start.
- **One limit to know:** the plugin cannot tell which conversation the agent is
  answering, so it cannot refuse a call for another space the bot is allowed
  in. What holds it: only allowed spaces can be read, a named space only one
  thread at a time, and the tool tells the model not to carry one
  conversation's history into another.

The sender's display label is cleaned before it is stored (one line, no
invisible or direction-changing characters, no tag or quote delimiters, at most
64 characters), because it is sender-chosen text that is later shown to a model.

## Email resolution

The gate needs a reliable email. Resolution chain:

1. **Event-provided** `message.sender.email` (present in some configs).
2. **Admin Directory** `users.get` → `primaryEmail` — **recommended production
   path.** Needs the Admin SDK API, scope
   `https://www.googleapis.com/auth/admin.directory.user.readonly`, domain-wide
   delegation, and `GOOGLECHAT_ADMIN_IMPERSONATE=<an-admin@domain>`.
3. **Id-fallback.** If no email resolves, the gate matches the raw
   `users/<id>` resource name against `allowFrom`/`owner` (put `users/<id>`
   values there). Degraded but functional in locked-down domains.

(People API is intentionally not used in v1 — unreliable for arbitrary users.)

## Single-consumer rule (important)

Multiple subscribers on **one** Pub/Sub subscription **load-balance** — two
sessions would each get half the messages, silently. **Use one subscription per
agent/session** (Pub/Sub delivers a full copy per subscription). A local PID lock
guards the same machine; only distinct subscriptions protect across machines.

## Configuration (`.env`, in `~/.claude/channels/googlechat/`)

| Key | Meaning |
| --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to the service-account JSON key (or use `GOOGLECHAT_SA_KEY_JSON` inline). |
| `GOOGLECHAT_PROJECT_ID` | GCP project id. |
| `GOOGLECHAT_SUBSCRIPTION` | Pull subscription (short id or full path). |
| `GOOGLECHAT_ADMIN_IMPERSONATE` | Admin email to impersonate for Directory lookups (optional, recommended). |
| `GOOGLECHAT_STATE_DIR` | Override the state dir (default `~/.claude/channels/googlechat`). |
| `GOOGLECHAT_ACCESS_MODE=static` | Snapshot `access.json` at boot (no re-read). |
| `GOOGLECHAT_HISTORY_DAYS` | Switches the local history on and says how many days it keeps a message (at most `90`). Unset or `0`: off, and a log left on disk is deleted at start. A value that is not a number also means off. |
| `GOOGLECHAT_HISTORY_MAX_MB` | Size cap of the local history file while it is on. Default `5`, at most `50`. |

## License

MIT — see [LICENSE](./LICENSE).
