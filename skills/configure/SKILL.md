---
name: configure
description: Set up the Google Chat channel — save the service-account credentials, project, subscription and owner email, and walk the one-time GCP/Workspace setup. Use when the user pastes Google Chat credentials, asks to configure Google Chat, asks "how do I set this up", or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /googlechat:configure — Google Chat Channel Setup

Writes credentials to `~/.claude/channels/googlechat/.env` and seeds
`~/.claude/channels/googlechat/access.json` with the owner. The server reads
both at boot. Inbound runs over Cloud Pub/Sub (no public URL); outbound over the
Chat REST API.

Arguments passed: `$ARGUMENTS`

---

## Required config (.env keys)

- `GOOGLE_APPLICATION_CREDENTIALS` — absolute path to the service-account JSON
  key (preferred), OR `GOOGLECHAT_SA_KEY_JSON` — the inline JSON (the server
  writes it to `sa-key.json`, chmod 600, on boot).
- `GOOGLECHAT_PROJECT_ID` — the GCP project id.
- `GOOGLECHAT_SUBSCRIPTION` — the PULL subscription (short id or full
  `projects/<p>/subscriptions/<s>`). **One subscription per agent/session.**
- `GOOGLECHAT_ADMIN_IMPERSONATE` — (optional, recommended) an admin email to
  impersonate for Directory email lookups.
- `GOOGLECHAT_ACCESS_MODE=static` — (optional) snapshot access.json at boot.
- `GOOGLECHAT_HISTORY_DAYS` (optional, off when unset): switches the local
  history on and says how many days it keeps what the bot saw (the inbound
  messages delivered to it and its own replies), at most 90. It stores the
  text of those messages in `history/log.jsonl` in the state dir (directory
  0700, file 0600). Unset or `0`: off, and a log left on disk is deleted at the
  next start. Set it only when the operator asks for it: say what it stores and
  for how long before writing the key.
- `GOOGLECHAT_HISTORY_MAX_MB` (optional): size cap of that log. Default 5.

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and report:

1. **Credentials** — does `.env` have `GOOGLE_APPLICATION_CREDENTIALS` (or
   `GOOGLECHAT_SA_KEY_JSON`)? Show set/not-set (mask the value). Show
   `GOOGLECHAT_PROJECT_ID` and `GOOGLECHAT_SUBSCRIPTION`.
2. **Access** — read `access.json` (missing = defaults: `policy:"allowlist"`,
   empty owner/allowlist = **drop-all**). Show policy, owner, allowFrom count +
   list, allowDomains, spaces count.
3. **What next** — concrete next step:
   - No credentials → *"Run `/googlechat:configure` and follow the GCP setup
     below, then save the key, project and subscription."*
   - Credentials set, no owner → *"Set yourself as owner:
     `/googlechat:access owner you@yourcompany.com`."*
   - Owner set, nobody else → *"Add company users with
     `/googlechat:access allow alice@company.com`, or allow the whole domain
     with `/googlechat:access domain add company.com` + `policy domain`."*

### `key <path>` — save the credentials path

1. `mkdir -p ~/.claude/channels/googlechat`
2. Read existing `.env`; set/replace `GOOGLE_APPLICATION_CREDENTIALS=<path>`,
   preserve other keys. No quotes.
3. `chmod 600 ~/.claude/channels/googlechat/.env`
4. Confirm; show status.

### `project <id>` / `subscription <name>` / `admin <email>`

Set the corresponding `.env` key (`GOOGLECHAT_PROJECT_ID`,
`GOOGLECHAT_SUBSCRIPTION`, `GOOGLECHAT_ADMIN_IMPERSONATE`). Read-modify-write,
preserve other keys, confirm.

### `clear` — remove credentials

Delete the credential keys (or the file if empty).

---

## One-time GCP / Workspace setup (walk the user through this)

See `SETUP.md` in the plugin for the full checklist. Summary:

1. Pick/create a GCP project → `GOOGLECHAT_PROJECT_ID`.
2. Enable APIs: **Google Chat API**, **Cloud Pub/Sub API** (+ **Admin SDK API**
   for Directory email lookup).
3. Create a Pub/Sub **topic** (e.g. `chat-inbound`).
4. Create a **PULL subscription** on it (one per agent) → `GOOGLECHAT_SUBSCRIPTION`.
5. Grant `chat-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher**
   role on the topic.
6. Create an **app service account**, download a JSON key.
7. Grant that service account **Pub/Sub Subscriber** on the subscription.
8. In the **Chat API configuration**: set app name/avatar; **Connection settings
   = Cloud Pub/Sub**, topic = step 3; **"Build as a Workspace add-on" =
   DISABLED**; set who can install.
9. (Directory email path) Enable **domain-wide delegation** for the service
   account on scope `https://www.googleapis.com/auth/admin.directory.user.readonly`
   and set `GOOGLECHAT_ADMIN_IMPERSONATE`.
10. Install / add the Chat app (admin install, or DM the app / add to a space).
11. Save config here, then relaunch Claude Code with
    `--channels plugin:googlechat@claude-channel-googlechat`.
12. Verify: DM the app from the owner account → the message appears in the session.

---

## Push toward lockdown — always

The goal is a defined allowlist (or a single trusted domain) with a named owner.
The default state is drop-all, which is safe but inert. After saving credentials:

1. Set the owner first (`/googlechat:access owner <email>`).
2. Add the specific people, or a single domain you control.
3. Never widen `allowDomains` to a domain you don't fully control.

---

## Implementation notes

- The channels dir may not exist before first run — missing file = not
  configured, not an error.
- `.env` is read once at boot. Credential/subscription changes need a session
  restart or `/reload-plugins`. Say so after saving.
- `access.json` is re-read on every inbound message — `/googlechat:access`
  changes take effect immediately.
