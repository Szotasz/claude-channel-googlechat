import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_REPLY_TO_MODE,
  forgetInbounds,
  parseReplyTarget,
  rememberInbound,
  rememberedThread,
  replyToModeOf,
  resolveReplyThread,
  threadForPart,
} from '../src/threading'

const SPACE = 'spaces/AAAA1'
const THREAD = `${SPACE}/threads/TTT1`
const MESSAGE = `${SPACE}/messages/MMM1.MMM1`
const neverAsked = async (): Promise<string | undefined> => {
  throw new Error('the API was asked')
}

beforeEach(() => forgetInbounds())

describe('parseReplyTarget', () => {
  test('no reply_to is a new thread, not an error', () => {
    expect(parseReplyTarget(SPACE, undefined)).toEqual({ kind: 'none' })
    expect(parseReplyTarget(SPACE, '')).toEqual({ kind: 'none' })
    expect(parseReplyTarget(SPACE, '   ')).toEqual({ kind: 'none' })
  })

  test('a thread name of the space', () => {
    expect(parseReplyTarget(SPACE, THREAD)).toEqual({ kind: 'thread', thread: THREAD })
  })

  test('a message name of the space', () => {
    expect(parseReplyTarget(SPACE, MESSAGE)).toEqual({ kind: 'message', message: MESSAGE })
  })

  test('a thread of another space is refused, and says so', () => {
    expect(() => parseReplyTarget(SPACE, 'spaces/BBBB2/threads/TTT1')).toThrow(/not in the space/)
  })

  test('a message of another space is refused', () => {
    expect(() => parseReplyTarget(SPACE, 'spaces/BBBB2/messages/MMM1')).toThrow(/not in the space/)
  })

  test('a bare id (the habit from other channels) is refused with the two accepted shapes named', () => {
    expect(() => parseReplyTarget(SPACE, '12345')).toThrow(/meta\.thread.*meta\.message_id/)
  })

  test('a name with a path in it is refused', () => {
    expect(() => parseReplyTarget(SPACE, `${THREAD}/../x`)).toThrow(/Nothing was sent/)
  })

  test('every refusal says nothing was sent', () => {
    for (const bad of ['12345', 'spaces/BBBB2/threads/T', `${SPACE}/threads/`, `${SPACE}/reactions/R`]) {
      expect(() => parseReplyTarget(SPACE, bad)).toThrow(/Nothing was sent/)
    }
  })
})

describe('threadForPart', () => {
  test('the default mode threads every part', () => {
    expect(DEFAULT_REPLY_TO_MODE).toBe('all')
    expect(replyToModeOf(undefined)).toBe('all')
    expect(replyToModeOf('bogus')).toBe('all')
    expect([0, 1, 2].map(i => threadForPart(replyToModeOf(undefined), i, THREAD))).toEqual([THREAD, THREAD, THREAD])
  })

  test('"first" threads the first part only', () => {
    expect([0, 1, 2].map(i => threadForPart('first', i, THREAD))).toEqual([THREAD, undefined, undefined])
  })

  test('"off" threads nothing', () => {
    expect([0, 1].map(i => threadForPart('off', i, THREAD))).toEqual([undefined, undefined])
  })

  test('no thread, no threading, whatever the mode', () => {
    expect(threadForPart('all', 0, undefined)).toBeUndefined()
  })

  test('an explicit setting is kept', () => {
    expect(replyToModeOf('first')).toBe('first')
    expect(replyToModeOf('off')).toBe('off')
    expect(replyToModeOf('all')).toBe('all')
  })
})

describe('resolveReplyThread', () => {
  test('a thread name is used as it is, the API is not asked', async () => {
    expect(await resolveReplyThread(SPACE, THREAD, neverAsked)).toBe(THREAD)
  })

  test('no reply_to resolves to no thread', async () => {
    expect(await resolveReplyThread(SPACE, undefined, neverAsked)).toBeUndefined()
  })

  test('a message this process delivered resolves from memory, the API is not asked', async () => {
    rememberInbound(MESSAGE, THREAD)
    expect(await resolveReplyThread(SPACE, MESSAGE, neverAsked)).toBe(THREAD)
  })

  test('a message of an older thread resolves to ITS thread, not the latest', async () => {
    const older = `${SPACE}/threads/OLD`
    rememberInbound(`${SPACE}/messages/A.A`, older)
    rememberInbound(`${SPACE}/messages/B.B`, THREAD)
    expect(await resolveReplyThread(SPACE, `${SPACE}/messages/A.A`, neverAsked)).toBe(older)
  })

  test('a message not in memory is looked up', async () => {
    const asked: string[] = []
    const got = await resolveReplyThread(SPACE, MESSAGE, async name => {
      asked.push(name)
      return THREAD
    })
    expect(got).toBe(THREAD)
    expect(asked).toEqual([MESSAGE])
  })

  test('a lookup that fails is an error, never a silent new thread', async () => {
    const failing = async (): Promise<string | undefined> => {
      throw new Error('403 PERMISSION_DENIED')
    }
    await expect(resolveReplyThread(SPACE, MESSAGE, failing)).rejects.toThrow(/could not be resolved: 403 PERMISSION_DENIED/)
    await expect(resolveReplyThread(SPACE, MESSAGE, failing)).rejects.toThrow(/Nothing was sent/)
  })

  test('a message with no thread is an error', async () => {
    await expect(resolveReplyThread(SPACE, MESSAGE, async () => undefined)).rejects.toThrow(/has no thread/)
  })

  test('a lookup that answers with a thread of another space is not trusted', async () => {
    await expect(resolveReplyThread(SPACE, MESSAGE, async () => 'spaces/BBBB2/threads/T')).rejects.toThrow(
      /could not be resolved/,
    )
  })

  test('a malformed reply_to never reaches the lookup', async () => {
    await expect(resolveReplyThread(SPACE, 'spaces/BBBB2/messages/M', neverAsked)).rejects.toThrow(/not in the space/)
  })
})

describe('the inbound memory', () => {
  test('a message without a thread is not remembered', () => {
    rememberInbound(MESSAGE, undefined)
    expect(rememberedThread(MESSAGE)).toBeUndefined()
  })

  test('it is bounded: the oldest entry goes first', () => {
    for (let i = 0; i < 2001; i++) rememberInbound(`${SPACE}/messages/N${i}`, THREAD)
    expect(rememberedThread(`${SPACE}/messages/N0`)).toBeUndefined()
    expect(rememberedThread(`${SPACE}/messages/N1`)).toBe(THREAD)
    expect(rememberedThread(`${SPACE}/messages/N2000`)).toBe(THREAD)
  })

  test('a message seen again keeps its place among the newest', () => {
    rememberInbound(`${SPACE}/messages/KEEP`, THREAD)
    for (let i = 0; i < 1999; i++) rememberInbound(`${SPACE}/messages/N${i}`, THREAD)
    rememberInbound(`${SPACE}/messages/KEEP`, THREAD)
    rememberInbound(`${SPACE}/messages/ONE.MORE`, THREAD)
    expect(rememberedThread(`${SPACE}/messages/KEEP`)).toBe(THREAD)
    expect(rememberedThread(`${SPACE}/messages/N0`)).toBeUndefined()
  })
})
