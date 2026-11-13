/**
 * Local history: what THIS bot saw of a conversation, kept on disk for a
 * bounded time, so an agent can re-read a thread after its own context is gone.
 *
 * It is deliberately not "the thread". Only two things are ever logged:
 *   - an inbound message that passed the access gate and was delivered, and
 *   - a message this bot sent with the reply tool (and its later edits).
 * A message the bot was not mentioned in, one the gate dropped, anything sent
 * before logging started or while the server was down, and every edit or
 * deletion made by a person are simply not here. The tool that reads this says
 * so to the model each time.
 *
 * The log holds message text, so it is kept tight:
 *   - STATE_DIR/history/ (0700), one file log.jsonl (0600), both re-asserted on
 *     every write; a file that is not ours to write is not followed.
 *   - bounded age (records older than `days` are removed at start, hourly and
 *     on writes, and never returned in between) and bounded size (the oldest
 *     records go first).
 *   - days = 0 switches it off: nothing is written, and the file is removed.
 *
 * One JSON object per line. The sender's display label is cleaned before it is
 * stored: it is sender-controlled text that is later shown to a model.
 */
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { HISTORY_DIR, HISTORY_DAYS, HISTORY_MAX_BYTES } from './config.js'

export type HistoryRecord = {
  /** ms epoch on this machine's clock when the record was written. Retention runs on it. */
  at: number
  /** ISO time shown to the reader (the message's createTime for an inbound). */
  ts: string
  dir: 'in' | 'out'
  space: string
  thread?: string
  message?: string
  /** Inbound: cleaned display label (email, else display name, else users/<id>). */
  user?: string
  /** Inbound: users/<id> as Google reported it. */
  user_id?: string
  /** Inbound: the role the access gate gave the sender. */
  role?: string
  /** Inbound: the space is a direct message. */
  dm?: boolean
  text: string
  truncated?: boolean
  /** Inbound: cleaned name (or kind) of the first attachment. */
  attachment?: string
  /** Outbound: number of files attached. */
  files?: number
  /** Outbound: this record is a later edit of `message`. */
  edited?: boolean
}

export type NewRecord = Omit<HistoryRecord, 'at' | 'ts' | 'truncated'> & { ts?: string }

export type HistoryOptions = {
  dir: string
  /** Retention in days. 0 (or less) switches the log off. */
  days: number
  maxBytes: number
  now?: () => number
}

export const MAX_TEXT_CHARS = 8192
export const MAX_LABEL_CHARS = 64
export const DEFAULT_READ_LIMIT = 30
export const MAX_READ_LIMIT = 100

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const DAY_MS = 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000
// After a size-triggered prune the file is cut to this share of the cap, so a
// busy log is not rewritten on every append.
const KEEP_SHARE = 0.75

// Control characters, zero-width and bidirectional controls, line separators.
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g
// Characters that delimit something where the label is later shown.
const DELIMITER_RE = /[<>\[\]{}"`;\\]/g

/**
 * A sender-controlled label made safe to store and to show to a model later:
 * one line, no invisible or direction-changing characters, no delimiter that
 * could close a tag or a quote, bounded length. Compatibility forms are folded
 * first, so a full-width bracket does not slip past as "not a bracket".
 */
export function cleanLabel(value: string | undefined | null): string {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE_RE, ' ')
    .replace(DELIMITER_RE, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(cleaned)
  return chars.length > MAX_LABEL_CHARS ? chars.slice(0, MAX_LABEL_CHARS).join('') : cleaned
}

type Line = { rec: HistoryRecord; raw: string }

function isRecord(v: any): v is HistoryRecord {
  return (
    v != null &&
    typeof v === 'object' &&
    typeof v.at === 'number' &&
    typeof v.space === 'string' &&
    typeof v.text === 'string' &&
    (v.dir === 'in' || v.dir === 'out')
  )
}

export type History = ReturnType<typeof createHistory>

export function createHistory(opts: HistoryOptions) {
  const now = opts.now ?? (() => Date.now())
  const enabled = opts.days > 0 && opts.maxBytes > 0
  const dir = opts.dir
  const file = join(dir, 'log.jsonl')
  let lastPrune = 0

  function cutoff(): number {
    return now() - opts.days * DAY_MS
  }

  /** The directory and the file exist only as ours, with tight modes. */
  function secure(): void {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    chmodSync(dir, DIR_MODE)
    let st
    try {
      st = lstatSync(file)
    } catch {
      return // not there yet: created 0600 by the write
    }
    // A symlink or anything that is not a plain file is not ours to append
    // message text to. Replace it rather than follow it.
    if (!st.isFile()) {
      rmSync(file, { recursive: true, force: true })
      return
    }
    chmodSync(file, FILE_MODE)
  }

  function load(): { lines: Line[]; dropped: number } {
    let raw: string
    try {
      if (!lstatSync(file).isFile()) return { lines: [], dropped: 0 }
      raw = readFileSync(file, 'utf8')
    } catch {
      return { lines: [], dropped: 0 }
    }
    const lines: Line[] = []
    let dropped = 0
    for (const l of raw.split('\n')) {
      if (!l) continue
      try {
        const rec = JSON.parse(l)
        if (isRecord(rec)) lines.push({ rec, raw: l })
        else dropped++
      } catch {
        dropped++ // a torn or foreign line: skipped on read, removed on prune
      }
    }
    return { lines, dropped }
  }

  function write(lines: Line[]): void {
    const tmp = `${file}.tmp`
    rmSync(tmp, { force: true })
    writeFileSync(tmp, lines.map(l => l.raw + '\n').join(''), { mode: FILE_MODE, flag: 'wx' })
    renameSync(tmp, file)
  }

  /**
   * Enforce both bounds on disk. `reserve` is the size of a line about to be
   * appended. Returns how many records were removed.
   */
  function prune(reserve = 0): number {
    if (!enabled) return 0
    lastPrune = now()
    const { lines, dropped } = load()
    const min = cutoff()
    let kept = lines.filter(l => l.rec.at >= min)
    const size = (ls: Line[]) => ls.reduce((n, l) => n + Buffer.byteLength(l.raw) + 1, 0)
    if (size(kept) + reserve > opts.maxBytes) {
      const target = Math.floor(opts.maxBytes * KEEP_SHARE) - reserve
      let total = size(kept)
      let from = 0
      while (from < kept.length && total > target) {
        total -= Buffer.byteLength(kept[from].raw) + 1
        from++
      }
      kept = kept.slice(from)
    }
    const removed = lines.length - kept.length
    if (removed === 0 && dropped === 0) return 0
    secure()
    write(kept)
    return removed
  }

  /** Remove the log. Used when the log is switched off, and by tests. */
  function purge(): void {
    rmSync(file, { recursive: true, force: true })
    rmSync(`${file}.tmp`, { force: true })
  }

  /**
   * One maintenance pass, run at start and every hour: on, the bounds are
   * enforced on disk; off, the log is removed, so a setting that says "off"
   * leaves no message text behind.
   */
  function maintain(): void {
    try {
      if (enabled) prune()
      else purge()
    } catch (err) {
      process.stderr.write(`googlechat channel: local history maintenance failed: ${err}\n`)
    }
  }

  /** Append one record. Never throws: a reply that was sent must not fail on its log. */
  function record(input: NewRecord): void {
    if (!enabled) return
    try {
      const text = String(input.text ?? '')
      const chars = text.length > MAX_TEXT_CHARS ? Array.from(text) : undefined
      const truncated = !!chars && chars.length > MAX_TEXT_CHARS
      const rec: HistoryRecord = {
        at: now(),
        ts: input.ts ?? new Date(now()).toISOString(),
        dir: input.dir,
        space: input.space,
        ...(input.thread ? { thread: input.thread } : {}),
        ...(input.message ? { message: input.message } : {}),
        ...(input.user !== undefined ? { user: cleanLabel(input.user) || 'unknown' } : {}),
        ...(input.user_id ? { user_id: cleanLabel(input.user_id) } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(input.dm ? { dm: true } : {}),
        text: truncated ? chars!.slice(0, MAX_TEXT_CHARS).join('') : text,
        ...(truncated ? { truncated: true } : {}),
        ...(input.attachment ? { attachment: cleanLabel(input.attachment) } : {}),
        ...(input.files ? { files: input.files } : {}),
        ...(input.edited ? { edited: true } : {}),
      }
      // An edit carries no thread of its own: it belongs where the message is.
      if (rec.edited && !rec.thread && rec.message) {
        const thread = threadOf(rec.message)
        if (thread) rec.thread = thread
      }
      const line = JSON.stringify(rec)
      const bytes = Buffer.byteLength(line) + 1
      secure()
      let size = 0
      try {
        size = lstatSync(file).size
      } catch {}
      if (size + bytes > opts.maxBytes || now() - lastPrune >= PRUNE_EVERY_MS) prune(bytes)
      appendFileSync(file, line + '\n', { mode: FILE_MODE })
    } catch (err) {
      process.stderr.write(`googlechat channel: local history write failed: ${err}\n`)
    }
  }

  /** Records inside the retention window, oldest first. */
  function fresh(): HistoryRecord[] {
    if (!enabled) return []
    const min = cutoff()
    return load()
      .lines.map(l => l.rec)
      .filter(r => r.at >= min)
  }

  /** The thread a logged message is in, if the log knows. */
  function threadOf(message: string): string | undefined {
    const recs = fresh()
    for (let i = recs.length - 1; i >= 0; i--) {
      if (recs[i].message === message && recs[i].thread) return recs[i].thread
    }
    return undefined
  }

  /** Whether the log has seen this space as a direct message. Undefined: never seen. */
  function isDm(space: string): boolean | undefined {
    const recs = fresh()
    for (let i = recs.length - 1; i >= 0; i--) {
      if (recs[i].space === space && recs[i].dir === 'in') return recs[i].dm === true
    }
    return undefined
  }

  /**
   * What the log holds for a space, or for one thread of it: the newest `limit`
   * records, oldest first. `older` counts the matching records left out. A
   * later edit replaces the text of the message it edits.
   */
  function read(q: { space: string; thread?: string; limit?: number }): { records: HistoryRecord[]; older: number } {
    const inSpace = fresh().filter(r => r.space === q.space)
    const merged: HistoryRecord[] = []
    const byMessage = new Map<string, HistoryRecord>()
    for (const r of inSpace) {
      const original = r.edited && r.message ? byMessage.get(r.message) : undefined
      if (original) {
        original.text = r.text
        original.edited = true
        if (r.truncated) original.truncated = true
        else delete original.truncated
        continue
      }
      const copy = { ...r }
      merged.push(copy)
      if (copy.message) byMessage.set(copy.message, copy)
    }
    const matching = q.thread === undefined ? merged : merged.filter(r => r.thread === q.thread)
    const wanted = Number.isFinite(q.limit) ? Math.floor(q.limit as number) : DEFAULT_READ_LIMIT
    const limit = Math.max(1, Math.min(wanted, MAX_READ_LIMIT))
    const records = matching.slice(-limit)
    return { records, older: matching.length - records.length }
  }

  return { enabled, days: opts.days, file, dir, record, read, threadOf, isDm, prune, purge, maintain }
}

/** The log of this server, under its state dir. */
export const history = createHistory({ dir: HISTORY_DIR, days: HISTORY_DAYS, maxBytes: HISTORY_MAX_BYTES })
