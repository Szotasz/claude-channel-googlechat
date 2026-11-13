/**
 * Config + state layout for the Google Chat channel.
 *
 * Mirrors the Telegram plugin's env/.env model: state lives under
 * ~/.claude/channels/googlechat/, credentials in .env (chmod 600), shell env
 * always wins. Loaded once at boot (this module's top-level side effects).
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const SERVICE = 'googlechat'
export const STATE_DIR =
  process.env.GOOGLECHAT_STATE_DIR ?? join(homedir(), '.claude', 'channels', SERVICE)
export const ACCESS_FILE = join(STATE_DIR, 'access.json')
export const ENV_FILE = join(STATE_DIR, '.env')
export const INBOX_DIR = join(STATE_DIR, 'inbox')
export const APPROVED_DIR = join(STATE_DIR, 'approved')
export const PID_FILE = join(STATE_DIR, 'bot.pid')
export const SA_KEY_FILE = join(STATE_DIR, 'sa-key.json')
export const HISTORY_DIR = join(STATE_DIR, 'history')

// Load STATE_DIR/.env into process.env. Real env wins. Plugin-spawned servers
// don't get an env block — this is where the credentials live.
try {
  // Credentials live here — lock to owner. No-op on Windows (would need ACLs).
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

/**
 * Resolve the service-account key file. Precedence:
 *   1. shell/.env GOOGLE_APPLICATION_CREDENTIALS (a path) — preferred
 *   2. GOOGLECHAT_SA_KEY_JSON (inline JSON) — written to STATE_DIR/sa-key.json
 *      (chmod 600) and pointed to via GOOGLE_APPLICATION_CREDENTIALS
 */
function resolveKeyFile(): string | undefined {
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (path) return path
  const inline = process.env.GOOGLECHAT_SA_KEY_JSON
  if (inline) {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(SA_KEY_FILE, inline, { mode: 0o600 })
    process.env.GOOGLE_APPLICATION_CREDENTIALS = SA_KEY_FILE
    return SA_KEY_FILE
  }
  return undefined
}

export const KEY_FILE = resolveKeyFile()
export const PROJECT_ID = process.env.GOOGLECHAT_PROJECT_ID ?? ''
// Accept a short id or a full projects/<p>/subscriptions/<s> path.
const RAW_SUBSCRIPTION = process.env.GOOGLECHAT_SUBSCRIPTION ?? ''
export const SUBSCRIPTION = RAW_SUBSCRIPTION.includes('/')
  ? RAW_SUBSCRIPTION.split('/').pop()!
  : RAW_SUBSCRIPTION
export const ADMIN_IMPERSONATE = process.env.GOOGLECHAT_ADMIN_IMPERSONATE ?? ''
export const STATIC = process.env.GOOGLECHAT_ACCESS_MODE === 'static'

/**
 * A bounded number from the environment. Unset: the default. A value that is
 * not a number switches the feature off (0) and says so, because what it
 * bounds is message text kept on disk: a typo must not mean "keep more".
 */
export function boundedNumber(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value < 0) {
    process.stderr.write(`googlechat channel: ${name}=${JSON.stringify(raw)} is not a number of 0 or more, treating it as 0 (off)\n`)
    return 0
  }
  return Math.min(value, max)
}

// Local history (src/history.ts): what this bot saw, kept for a bounded time.
export const HISTORY_DEFAULT_DAYS = 14
export const HISTORY_MAX_DAYS = 90
export const HISTORY_DEFAULT_MB = 5
export const HISTORY_MAX_MB = 50
/** Retention in days. 0 switches the local history off and removes the log. */
export const HISTORY_DAYS = boundedNumber(
  'GOOGLECHAT_HISTORY_DAYS',
  process.env.GOOGLECHAT_HISTORY_DAYS,
  HISTORY_DEFAULT_DAYS,
  HISTORY_MAX_DAYS,
)
export const HISTORY_MAX_BYTES = Math.floor(
  boundedNumber('GOOGLECHAT_HISTORY_MAX_MB', process.env.GOOGLECHAT_HISTORY_MAX_MB, HISTORY_DEFAULT_MB, HISTORY_MAX_MB) *
    1024 *
    1024,
)

export const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot'
export const DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly'

export const MAX_CHUNK_LIMIT = 4096
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

/** Fail fast with a precise message if required config is missing. */
export function assertConfig(): void {
  const missing: string[] = []
  if (!KEY_FILE) missing.push('GOOGLE_APPLICATION_CREDENTIALS (or GOOGLECHAT_SA_KEY_JSON)')
  if (!PROJECT_ID) missing.push('GOOGLECHAT_PROJECT_ID')
  if (!SUBSCRIPTION) missing.push('GOOGLECHAT_SUBSCRIPTION')
  if (missing.length) {
    process.stderr.write(
      `googlechat channel: missing config: ${missing.join(', ')}\n` +
        `  set in ${ENV_FILE} (run /googlechat:configure)\n`,
    )
    process.exit(1)
  }
}
