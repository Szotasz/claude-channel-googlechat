# Access model

Identity-based access control for the Google Chat channel. Because Google Chat
delivers a **verified Workspace identity**, there is no pairing flow — the gate
keys on email/domain and assigns an **owner/user** role.

State: `~/.claude/channels/googlechat/access.json`, re-read on every inbound
message (unless `GOOGLECHAT_ACCESS_MODE=static`). Managed only by
`/googlechat:access` — the server never mutates it and never acts on
"add me"/"make me owner" requests arriving in chat (prompt-injection guard).

## Schema

```jsonc
{
  "policy": "allowlist",            // allowlist | domain | disabled
  "owner": "owner@company.com",     // privileged operator → meta.role "owner"
  "allowFrom": ["alice@company.com"], // explicit allowed emails (or users/<id>)
  "allowDomains": ["company.com"],    // for policy:"domain"
  "roles": { "lead@company.com": "owner" }, // extra role overrides
  "spaces": {                       // per-space (room) opt-in; DMs don't need this
    "spaces/AAAA": { "requireMention": true, "allowFrom": [] }
  },
  "mentionPatterns": ["^hey claude\\b"], // regexes that count as a mention
  "ackReaction": "👀",              // best-effort receipt reaction
  "replyToMode": "all",             // off | first | all: which parts of a split reply go in the thread (default: all)
  "textChunkLimit": 4096,
  "chunkMode": "newline"            // length | newline
}
```

**Default (missing file): drop-all.** `policy:"allowlist"`, empty owner and
lists — nothing is delivered until you set an owner and at least one allow rule.

## Gate logic

For each inbound `MESSAGE`:

1. `policy:"disabled"` → drop.
2. Resolve the sender's email (see chain below). The authorization key is the
   email, or — if unresolvable — the raw `users/<id>`.
3. **DM:** deliver if the email is in `allowFrom`, equals `owner`, has a `roles`
   entry, or (when `policy:"domain"`) its domain is in `allowDomains`. In
   id-fallback mode the raw `users/<id>` must be in `allowFrom`/`owner`/`roles`.
4. **Space (room):** requires a `spaces[<name>]` entry (opt-in). If that entry's
   `allowFrom` is non-empty the sender must be in it; if `requireMention` is true
   the bot must be @mentioned (or a `mentionPatterns` regex matches).
5. On deliver, compute the role: `owner` if the key equals `owner` or
   `roles[key] === "owner"`, else `user`. Exposed as `meta.role`.

## Outbound gate

`reply`/`react`/`edit_message` may only target a space the session has delivered
from this run, or one present in `spaces`. This prevents the agent from being
steered (via prompt injection) into messaging arbitrary spaces.

## Email resolution chain

1. **Event-provided** `message.sender.email`.
2. **Admin Directory** `users.get(userKey)` → `primaryEmail`. Needs the Admin SDK
   API, scope `admin.directory.user.readonly`, domain-wide delegation, and
   `GOOGLECHAT_ADMIN_IMPERSONATE`. **Recommended.**
3. **Id-fallback.** No email → match raw `users/<id>` against the allowlist; set
   `owner`/`allowFrom` entries to `users/<id>` values. `meta.user` falls back to
   the display name, then `users/<id>`.

## Owner / role and permissions

- The `owner` is the single privileged operator. Tool-use **permission prompts**
  (Claude Code asking to run a tool) are routed **only** to the owner's DM; the
  owner replies `yes <id>` / `no <id>` to allow/deny.
- Add a second privileged person with `role <email> owner` without changing the
  primary `owner`.

## Recommended postures

- **Single company, you control the domain:** `policy:"domain"`,
  `allowDomains:["company.com"]`, `owner` = you. Everyone in the domain is a
  `user`; you're the `owner`.
- **Tight allowlist:** `policy:"allowlist"`, list each email; safest.
- Never list a domain you don't fully control.
