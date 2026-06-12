/**
 * Sender → Workspace email resolution. This is the load-bearing divergence from
 * the Telegram plugin: the gate and role mapping need a reliable email.
 *
 * Resolution chain (first that succeeds wins):
 *   1. Event-provided email (message.sender.email) — present in some configs.
 *   2. Admin Directory users.get(userKey) → primaryEmail. RECOMMENDED production
 *      path. Needs admin.directory.user.readonly + domain-wide delegation and
 *      GOOGLECHAT_ADMIN_IMPERSONATE (an admin to impersonate).
 *   3. People API best-effort (often unavailable for arbitrary users).
 *   4. None → caller falls back to id-based allowlist (users/<id>).
 *
 * Results are cached in-memory (userId → email) to avoid per-message API calls.
 */
import { readFileSync } from 'fs'
import { JWT } from 'google-auth-library'
import { admin as adminApi } from '@googleapis/admin'
import { KEY_FILE, DIRECTORY_SCOPE, ADMIN_IMPERSONATE } from './config.js'

export type Sender = {
  name?: string // users/123
  displayName?: string
  email?: string
  type?: string
}

const emailCache = new Map<string, string>()

function userIdOf(sender: Sender): string | undefined {
  return sender.name?.replace(/^users\//, '') || undefined
}

let directoryClient: ReturnType<typeof adminApi> | null | undefined

function getDirectoryClient() {
  if (directoryClient !== undefined) return directoryClient
  if (!ADMIN_IMPERSONATE || !KEY_FILE) {
    directoryClient = null
    return null
  }
  try {
    const key = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    const auth = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [DIRECTORY_SCOPE],
      subject: ADMIN_IMPERSONATE, // impersonate an admin for Directory reads
    })
    directoryClient = adminApi({ version: 'directory_v1', auth })
  } catch (err) {
    process.stderr.write(`googlechat channel: directory client init failed: ${err}\n`)
    directoryClient = null
  }
  return directoryClient
}

async function directoryLookup(userId: string): Promise<string | undefined> {
  const dir = getDirectoryClient()
  if (!dir) return undefined
  try {
    const res = await dir.users.get({ userKey: userId })
    return res.data.primaryEmail ?? undefined
  } catch (err) {
    process.stderr.write(`googlechat channel: directory lookup for ${userId} failed: ${err}\n`)
    return undefined
  }
}

/**
 * Resolve a sender's email. Returns undefined when no path succeeds — the gate
 * then uses id-based matching against the raw users/<id> resource name.
 */
export async function resolveEmail(sender: Sender | undefined): Promise<string | undefined> {
  if (!sender) return undefined
  if (sender.email) return sender.email
  const userId = userIdOf(sender)
  if (!userId) return undefined
  if (emailCache.has(userId)) return emailCache.get(userId)

  const fromDir = await directoryLookup(userId)
  if (fromDir) {
    emailCache.set(userId, fromDir)
    return fromDir
  }
  // People API fallback is intentionally not implemented in v1: for arbitrary
  // Workspace users it requires contact sharing or OAuth user context and is
  // unreliable. Directory (path 2) is the supported production path. See README.
  return undefined
}

/** Best display label for meta.user: email → displayName → users/<id>. */
export function displayUser(sender: Sender | undefined, email: string | undefined): string {
  return email ?? sender?.displayName ?? sender?.name ?? 'unknown'
}
