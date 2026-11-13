/**
 * Reply threading: where a reply goes, decided BEFORE anything is sent.
 *
 * A reply that lands outside the thread of the question is the one failure a
 * user of a threaded space notices at once, and the Chat API makes it easy to
 * get silently: a message created with no thread starts a new one. So this
 * module is strict about its input and loud about what it cannot place:
 *
 *   - `reply_to` may be a thread name (spaces/X/threads/T, the inbound
 *     meta.thread) or a message name (spaces/X/messages/M, the inbound
 *     meta.message_id). A message name is resolved to its thread.
 *   - Either must belong to the space the reply is addressed to.
 *   - Anything else is an error. Nothing is sent.
 *
 * Pure functions plus one small in-memory map; no I/O, so it is unit-tested
 * without a Google account.
 */

export type ReplyToMode = 'off' | 'first' | 'all'

/**
 * Every part of a chunked reply goes into the thread unless the operator says
 * otherwise. ('first' was the default before: it threads the first part only,
 * and every later part opens a thread of its own.)
 */
export const DEFAULT_REPLY_TO_MODE: ReplyToMode = 'all'

export function replyToModeOf(value: unknown): ReplyToMode {
  return value === 'off' || value === 'first' || value === 'all' ? value : DEFAULT_REPLY_TO_MODE
}

export type ReplyTarget =
  | { kind: 'none' }
  | { kind: 'thread'; thread: string }
  | { kind: 'message'; message: string }

const SPACE_RE = /^spaces\/[A-Za-z0-9_-]+$/
const LEAF_RE = /^[A-Za-z0-9_.-]+$/

function under(space: string, collection: 'threads' | 'messages', name: string): boolean {
  const prefix = `${space}/${collection}/`
  return name.startsWith(prefix) && LEAF_RE.test(name.slice(prefix.length))
}

/**
 * Classify `reply_to` for a reply addressed to `space`. Throws on a value that
 * names neither a thread nor a message of that space: sending such a reply
 * unthreaded would look like success and land in the wrong place.
 */
export function parseReplyTarget(space: string, replyTo: string | undefined | null): ReplyTarget {
  const value = (replyTo ?? '').trim()
  if (!value) return { kind: 'none' }
  if (!SPACE_RE.test(space)) {
    throw new Error(`chat_id is not a space resource name: ${space}`)
  }
  if (under(space, 'threads', value)) return { kind: 'thread', thread: value }
  if (under(space, 'messages', value)) return { kind: 'message', message: value }
  const otherSpace = /^spaces\/[^/]+\/(threads|messages)\//.test(value)
  throw new Error(
    otherSpace
      ? `reply_to (${value}) is not in the space the reply is addressed to (${space}). Nothing was sent.`
      : `reply_to (${value}) is neither a thread name (${space}/threads/...) nor a message name (${space}/messages/...). ` +
        'Pass the inbound meta.thread, or the inbound meta.message_id. Nothing was sent.',
  )
}

/** Which thread, if any, part `index` of a chunked reply is created in. */
export function threadForPart(mode: ReplyToMode, index: number, thread: string | undefined): string | undefined {
  if (!thread || mode === 'off') return undefined
  return mode === 'all' || index === 0 ? thread : undefined
}

// message name -> thread name, for the inbound messages this process delivered.
// Bounded; the oldest entry goes first. Lost on restart, by design: the caller
// falls back to asking the API, and fails loudly if that cannot answer either.
const MAX_REMEMBERED = 2000
const threadByMessage = new Map<string, string>()

export function rememberInbound(message: string | undefined, thread: string | undefined): void {
  if (!message || !thread) return
  threadByMessage.delete(message)
  threadByMessage.set(message, thread)
  while (threadByMessage.size > MAX_REMEMBERED) {
    const oldest = threadByMessage.keys().next().value
    if (oldest === undefined) break
    threadByMessage.delete(oldest)
  }
}

export function rememberedThread(message: string): string | undefined {
  return threadByMessage.get(message)
}

// Direct-message spaces this process delivered a message from. A threaded
// create in one of these keeps the lenient reply option (see chat-client.ts):
// what a DM does with the strict one has not been measured, and a DM is where
// the owner talks to the bot. One entry per person who may DM the bot.
const dmSpaces = new Set<string>()

export function rememberDmSpace(space: string | undefined): void {
  if (space) dmSpaces.add(space)
}

export function isKnownDm(space: string): boolean {
  return dmSpaces.has(space)
}

/** Test hook. */
export function forgetInbounds(): void {
  threadByMessage.clear()
  dmSpaces.clear()
}

/**
 * The thread a reply goes into. `lookup` asks the API for a message's thread
 * and is only called for a message this process did not deliver itself.
 */
export async function resolveReplyThread(
  space: string,
  replyTo: string | undefined | null,
  lookup: (message: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  const target = parseReplyTarget(space, replyTo)
  if (target.kind === 'none') return undefined
  if (target.kind === 'thread') return target.thread
  const known = rememberedThread(target.message)
  if (known) return known
  let found: string | undefined
  let why = 'the message has no thread'
  try {
    found = await lookup(target.message)
  } catch (err) {
    why = err instanceof Error ? err.message : String(err)
  }
  if (found && under(space, 'threads', found)) return found
  throw new Error(
    `reply_to names a message (${target.message}) whose thread could not be resolved: ${why}. ` +
      'Pass the inbound meta.thread instead. Nothing was sent.',
  )
}
