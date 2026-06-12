/**
 * Identity-based access control for the Google Chat channel.
 *
 * Unlike Telegram (which captures opaque numeric ids via a pairing code), Google
 * Chat delivers a VERIFIED Workspace identity, so we gate on email / domain and
 * derive an owner/user role. There is no pairing flow; the default is drop-all
 * until the owner configures access via /googlechat:access.
 *
 * State lives in ~/.claude/channels/googlechat/access.json and is re-read on
 * every inbound message unless GOOGLECHAT_ACCESS_MODE=static.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { ACCESS_FILE, STATE_DIR, STATIC } from './config.js'

export type Role = 'owner' | 'user'

export type SpacePolicy = {
  /** Require an @bot mention (or a mentionPatterns match) to deliver. Default true. */
  requireMention?: boolean
  /** If non-empty, only these emails/ids may trigger delivery in this space. */
  allowFrom?: string[]
}

export type Access = {
  /** allowlist = explicit emails/ids; domain = any sender in allowDomains; disabled = drop all. */
  policy: 'allowlist' | 'domain' | 'disabled'
  /** The owner's email (or users/<id> in id-fallback mode). Resolves to role "owner". */
  owner: string
  /** Explicitly allowed emails (role "user" unless overridden in roles). */
  allowFrom: string[]
  /** For policy:"domain" — any sender whose email domain is listed is allowed. */
  allowDomains: string[]
  /** Per-email role overrides (e.g. a second owner). */
  roles: Record<string, Role>
  /** Per-space opt-in for room/space (non-DM) messages. */
  spaces: Record<string, SpacePolicy>
  mentionPatterns?: string[]
  /** Emoji to react with on receipt; best-effort (app reactions are often restricted). */
  ackReaction?: string
  /** Which chunks of a chunked reply thread under the inbound message. Default 'first'. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default 4096. */
  textChunkLimit?: number
  chunkMode?: 'length' | 'newline'
}

export function defaultAccess(): Access {
  return {
    policy: 'allowlist',
    owner: '',
    allowFrom: [],
    allowDomains: [],
    roles: {},
    spaces: {},
  }
}

function readAccessFile(): Access {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const p = JSON.parse(raw) as Partial<Access>
    return {
      policy: p.policy ?? 'allowlist',
      owner: p.owner ?? '',
      allowFrom: p.allowFrom ?? [],
      allowDomains: p.allowDomains ?? [],
      roles: p.roles ?? {},
      spaces: p.spaces ?? {},
      mentionPatterns: p.mentionPatterns,
      ackReaction: p.ackReaction,
      replyToMode: p.replyToMode,
      textChunkLimit: p.textChunkLimit,
      chunkMode: p.chunkMode,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccess()
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`)
    } catch {}
    process.stderr.write('googlechat channel: access.json is corrupt, moved aside. Starting fresh (drop-all).\n')
    return defaultAccess()
  }
}

// In static mode, snapshot access at boot and never re-read.
const BOOT_ACCESS: Access | null = STATIC ? readAccessFile() : null

export function loadAccess(): Access {
  return BOOT_ACCESS ?? readAccessFile()
}

// Set of space resource names we have delivered a message from this session,
// plus all configured spaces. The outbound gate requires membership so the
// agent can't be tricked (via prompt injection) into messaging arbitrary spaces.
const deliveredSpaces = new Set<string>()

export function markDelivered(spaceName: string): void {
  deliveredSpaces.add(spaceName)
}

/** Outbound gate — reply/react/edit may only target a space we've heard from. */
export function assertAllowedChat(chat_id: string): void {
  if (deliveredSpaces.has(chat_id)) return
  if (chat_id in loadAccess().spaces) return
  throw new Error(`space ${chat_id} is not allowlisted — add via /googlechat:access`)
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at >= 0 ? email.slice(at + 1).toLowerCase() : ''
}

function roleFor(access: Access, key: string): Role {
  if (!key) return 'user'
  if (key.toLowerCase() === access.owner.toLowerCase()) return 'owner'
  // roles map may be keyed by email or users/<id>; compare case-insensitively for emails
  for (const [k, v] of Object.entries(access.roles)) {
    if (k.toLowerCase() === key.toLowerCase()) return v
  }
  return 'user'
}

export type GateInput = {
  access: Access
  /** Resolved Workspace email, if available. */
  email?: string
  /** Raw sender resource name, e.g. users/123 — used in id-fallback mode. */
  senderId?: string
  isDM: boolean
  spaceName: string
  mentioned: boolean
}

export type GateResult = { action: 'deliver'; role: Role } | { action: 'drop' }

/**
 * Decide whether to deliver an inbound MESSAGE and with which role.
 * `email` is preferred; when it can't be resolved we fall back to matching the
 * raw `senderId` (users/<id>) against allowFrom/owner/roles (degraded mode).
 */
export function gate(input: GateInput): GateResult {
  const { access, email, senderId, isDM, spaceName, mentioned } = input
  if (access.policy === 'disabled') return { action: 'drop' }

  // The identity key we authorize on: email if we have it, else the raw id.
  const key = email ?? senderId ?? ''
  if (!key) return { action: 'drop' }

  const isAllowedUser = (): boolean => {
    if (email) {
      if (access.policy === 'domain' && access.allowDomains.map(d => d.toLowerCase()).includes(domainOf(email)))
        return true
      if (access.allowFrom.some(e => e.toLowerCase() === email.toLowerCase())) return true
      if (email.toLowerCase() === access.owner.toLowerCase()) return true
      if (access.roles && Object.keys(access.roles).some(k => k.toLowerCase() === email.toLowerCase())) return true
      return false
    }
    // id-fallback: match raw users/<id> against allowFrom / owner / roles
    const id = senderId ?? ''
    if (access.allowFrom.includes(id)) return true
    if (id && id === access.owner) return true
    if (access.roles && id in access.roles) return true
    return false
  }

  if (isDM) {
    if (!isAllowedUser()) return { action: 'drop' }
    return { action: 'deliver', role: roleFor(access, key) }
  }

  // Space (room) message — must be opted in via /googlechat:access space add.
  const sp = access.spaces[spaceName]
  if (!sp) return { action: 'drop' }
  const spaceAllow = sp.allowFrom ?? []
  if (spaceAllow.length > 0) {
    const inList = email
      ? spaceAllow.some(e => e.toLowerCase() === email.toLowerCase())
      : spaceAllow.includes(senderId ?? '')
    if (!inList) return { action: 'drop' }
  }
  const requireMention = sp.requireMention ?? true
  if (requireMention && !mentioned) return { action: 'drop' }
  return { action: 'deliver', role: roleFor(access, key) }
}

/** Save (used by tooling/tests; the server itself never mutates access.json). */
export function saveAccess(a: Access): void {
  if (STATIC) return
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  const tmp = ACCESS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(a, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, ACCESS_FILE)
}
