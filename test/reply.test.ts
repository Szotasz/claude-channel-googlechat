/**
 * The reply tool, driven with stand-ins for the Chat API. Nothing here talks to
 * Google: what is tested is which thread each created message is addressed to,
 * and that a reply that cannot be placed sends nothing.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { STATE } from './state'

const { handleReply } = await import('../src/tools')
const { forgetInbounds, rememberDmSpace, rememberInbound } = await import('../src/threading')
type ReplyDeps = import('../src/tools').ReplyDeps

const SPACE = 'spaces/AAAA1'
const THREAD = `${SPACE}/threads/TTT1`
const MESSAGE = `${SPACE}/messages/MMM1.MMM1`
const LONG = 'a'.repeat(4096 * 2 + 10) // three parts at the default limit

type Created = { text: string; thread: string | undefined; files: number }

function world(access: Record<string, unknown> = {}, over: Partial<ReplyDeps> = {}) {
  const created: Created[] = []
  const lookups: string[] = []
  const deps: ReplyDeps = {
    assertAllowedChat: () => {},
    loadAccess: () => ({ policy: 'allowlist', owner: '', allowFrom: [], allowDomains: [], roles: {}, spaces: {}, ...access }) as any,
    createMessage: async (_space, text, thread) => {
      created.push({ text, thread, files: 0 })
      return { name: `${SPACE}/messages/OUT${created.length}` }
    },
    createMessageWithAttachments: async (_space, text, attachments, thread) => {
      created.push({ text, thread, files: attachments.length })
      return { name: `${SPACE}/messages/OUT${created.length}` }
    },
    uploadAttachment: async () => ({ attachmentDataRef: { resourceName: 'r' } }),
    getMessageThread: async name => {
      lookups.push(name)
      return undefined
    },
    ...over,
  }
  return { deps, created, lookups }
}

const textOf = (res: any): string => res.content[0].text

beforeEach(() => forgetInbounds())

describe('where a reply goes', () => {
  test('a thread name: the message is created in that thread', async () => {
    const w = world()
    const res = await handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD }, w.deps)
    expect(w.created).toEqual([{ text: 'ok', thread: THREAD, files: 0 }])
    expect(textOf(res)).toBe(`sent (id: ${SPACE}/messages/OUT1)`)
  })

  test('no reply_to: a new thread, as before', async () => {
    const w = world()
    await handleReply({ chat_id: SPACE, text: 'ok' }, w.deps)
    expect(w.created.map(c => c.thread)).toEqual([undefined])
  })

  test('the inbound message name: resolved to its thread from memory, the API is not asked', async () => {
    rememberInbound(MESSAGE, THREAD)
    const w = world()
    await handleReply({ chat_id: SPACE, text: 'ok', reply_to: MESSAGE }, w.deps)
    expect(w.created.map(c => c.thread)).toEqual([THREAD])
    expect(w.lookups).toEqual([])
  })

  test('a message name not in memory: the API is asked, and its answer is used', async () => {
    const w = world({}, { getMessageThread: async () => THREAD })
    await handleReply({ chat_id: SPACE, text: 'ok', reply_to: MESSAGE }, w.deps)
    expect(w.created.map(c => c.thread)).toEqual([THREAD])
  })
})

describe('a reply that cannot be placed sends NOTHING', () => {
  test('a message name whose thread cannot be resolved', async () => {
    const w = world()
    await expect(handleReply({ chat_id: SPACE, text: 'ok', reply_to: MESSAGE }, w.deps)).rejects.toThrow(
      /could not be resolved/,
    )
    expect(w.created).toEqual([])
    expect(w.lookups).toEqual([MESSAGE])
  })

  test('a thread of another space', async () => {
    const w = world()
    await expect(
      handleReply({ chat_id: SPACE, text: 'ok', reply_to: 'spaces/BBBB2/threads/TTT1' }, w.deps),
    ).rejects.toThrow(/not in the space/)
    expect(w.created).toEqual([])
  })

  test('a bare id', async () => {
    const w = world()
    await expect(handleReply({ chat_id: SPACE, text: 'ok', reply_to: '4711' }, w.deps)).rejects.toThrow(
      /neither a thread name/,
    )
    expect(w.created).toEqual([])
  })

  test('a thread Google refuses: the error names the thread and says nothing was sent', async () => {
    const w = world({}, {
      createMessage: async () => {
        throw new Error('NOT_FOUND: thread not found')
      },
    })
    const p = handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD }, w.deps)
    await expect(p).rejects.toThrow(/NOT_FOUND/)
    await expect(p).rejects.toThrow(new RegExp(THREAD))
    await expect(p).rejects.toThrow(/Nothing was sent/)
  })
})

describe('a direct message keeps the lenient reply option until a DM is measured', () => {
  // What each create was asked: the stand-ins record the options they were given.
  function recording(over: Partial<ReplyDeps> = {}) {
    const asked: Array<{ kind: string; thread: string | undefined; directMessage: unknown }> = []
    const w = world({}, {
      createMessage: async (_space, _text, thread, opts) => {
        asked.push({ kind: 'text', thread, directMessage: opts?.directMessage })
        return { name: `${SPACE}/messages/OUT${asked.length}` }
      },
      createMessageWithAttachments: async (_space, _text, _attachments, thread, opts) => {
        asked.push({ kind: 'files', thread, directMessage: opts?.directMessage })
        return { name: `${SPACE}/messages/OUT${asked.length}` }
      },
      ...over,
    })
    return { ...w, asked }
  }
  const outside = join(tmpdir(), 'gchat-reply-test-dm-note.txt')
  writeFileSync(outside, 'x')

  test('a space known to be a direct message: every create is told so', async () => {
    rememberDmSpace(SPACE)
    const w = recording()
    await handleReply({ chat_id: SPACE, text: LONG, reply_to: THREAD, format: 'markdownv2', files: [outside] }, w.deps)
    expect(w.asked).toEqual([
      { kind: 'text', thread: THREAD, directMessage: true },
      { kind: 'text', thread: THREAD, directMessage: true },
      { kind: 'text', thread: THREAD, directMessage: true },
      { kind: 'files', thread: THREAD, directMessage: true },
    ])
  })

  test('any other space, and a space this process has not heard from: strict', async () => {
    rememberDmSpace('spaces/SOMEONEELSE')
    const w = recording()
    await handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD, files: [outside] }, w.deps)
    expect(w.asked).toEqual([
      { kind: 'text', thread: THREAD, directMessage: false },
      { kind: 'files', thread: THREAD, directMessage: false },
    ])
  })

  test('the note about a failed upload is told the same', async () => {
    rememberDmSpace(SPACE)
    const w = recording({
      uploadAttachment: async () => {
        throw new Error('upload not enabled')
      },
    })
    await handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD, files: [outside] }, w.deps)
    expect(w.asked.map(a => a.directMessage)).toEqual([true, true])
  })

  test('a strict failure tells how to resend if the space is a direct message after all', async () => {
    const w = world({}, {
      createMessage: async () => {
        throw new Error('INVALID_ARGUMENT')
      },
    })
    const p = handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD }, w.deps)
    await expect(p).rejects.toThrow(/fails here instead of opening a new thread/)
    await expect(p).rejects.toThrow(/If this space is a direct message, send it again without reply_to/)
  })

  test('a failure in a known direct message does not blame the thread or offer that way out', async () => {
    rememberDmSpace(SPACE)
    const w = world({}, {
      createMessage: async () => {
        throw new Error('503 backend error')
      },
    })
    const p = handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD }, w.deps)
    await expect(p).rejects.toThrow(new RegExp(`the message was not sent: 503 backend error\\. It was addressed to thread ${THREAD}\\. Nothing was sent\\.`))
    await expect(p).rejects.not.toThrow(/send it again without reply_to/)
  })
})

describe('a reply the plugin splits', () => {
  test('default setting: EVERY part is in the thread', async () => {
    const w = world()
    const res = await handleReply({ chat_id: SPACE, text: LONG, reply_to: THREAD, format: 'markdownv2' }, w.deps)
    expect(w.created.length).toBe(3)
    expect(w.created.map(c => c.thread)).toEqual([THREAD, THREAD, THREAD])
    expect(textOf(res)).toBe(
      `sent 3 parts (ids: ${SPACE}/messages/OUT1, ${SPACE}/messages/OUT2, ${SPACE}/messages/OUT3)`,
    )
  })

  test('"replyToMode": "first" is still honoured: the first part only', async () => {
    const w = world({ replyToMode: 'first' })
    await handleReply({ chat_id: SPACE, text: LONG, reply_to: THREAD, format: 'markdownv2' }, w.deps)
    expect(w.created.map(c => c.thread)).toEqual([THREAD, undefined, undefined])
  })

  test('"replyToMode": "off" is still honoured: no part is threaded', async () => {
    const w = world({ replyToMode: 'off' })
    await handleReply({ chat_id: SPACE, text: LONG, reply_to: THREAD, format: 'markdownv2' }, w.deps)
    expect(w.created.map(c => c.thread)).toEqual([undefined, undefined, undefined])
  })

  test('an unknown replyToMode value is the default (all)', async () => {
    const w = world({ replyToMode: 'sometimes' })
    await handleReply({ chat_id: SPACE, text: LONG, reply_to: THREAD, format: 'markdownv2' }, w.deps)
    expect(w.created.map(c => c.thread)).toEqual([THREAD, THREAD, THREAD])
  })

  test('a part that fails midway: the error says which parts are already out', async () => {
    let n = 0
    const w = world({}, {
      createMessage: async () => {
        n += 1
        if (n === 2) throw new Error('503 backend error')
        return { name: `${SPACE}/messages/OUT${n}` }
      },
    })
    const p = handleReply({ chat_id: SPACE, text: LONG, reply_to: THREAD, format: 'markdownv2' }, w.deps)
    await expect(p).rejects.toThrow(/part 2 of 3 was not sent: 503 backend error/)
    await expect(p).rejects.toThrow(new RegExp(`Already sent: ${SPACE}/messages/OUT1`))
  })
})

describe('attachments', () => {
  const file = join(STATE, 'note.txt')
  writeFileSync(join(tmpdir(), 'gchat-reply-test-note.txt'), 'x')
  const outside = join(tmpdir(), 'gchat-reply-test-note.txt')

  test('the attachment message is in the thread too', async () => {
    const w = world()
    await handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD, files: [outside] }, w.deps)
    expect(w.created).toEqual([
      { text: 'ok', thread: THREAD, files: 0 },
      { text: '', thread: THREAD, files: 1 },
    ])
  })

  test('replyToMode governs the text parts only: the attachment message is threaded as it always was', async () => {
    for (const replyToMode of ['first', 'off']) {
      const w = world({ replyToMode })
      await handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD, files: [outside] }, w.deps)
      expect(w.created[1]).toEqual({ text: '', thread: THREAD, files: 1 })
    }
  })

  test('a message name as reply_to places the attachment message as well', async () => {
    rememberInbound(MESSAGE, THREAD)
    const w = world()
    await handleReply({ chat_id: SPACE, text: 'ok', reply_to: MESSAGE, files: [outside] }, w.deps)
    expect(w.created.map(c => c.thread)).toEqual([THREAD, THREAD])
  })

  test('the attachment message AND its note both fail: the error says why, where, and what is already out', async () => {
    const w = world({}, {
      createMessage: async (_space, text, thread) => {
        if (text.startsWith('(attachment upload unavailable')) throw new Error('NOT_FOUND: thread not found')
        w.created.push({ text, thread, files: 0 })
        return { name: `${SPACE}/messages/OUT${w.created.length}` }
      },
      createMessageWithAttachments: async () => {
        throw new Error('NOT_FOUND: thread not found')
      },
    })
    const p = handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD, files: [outside] }, w.deps)
    await expect(p).rejects.toThrow(/the attachment message was not sent: NOT_FOUND: thread not found; the note about it could not be sent either: NOT_FOUND: thread not found\./)
    await expect(p).rejects.toThrow(new RegExp(`addressed to thread ${THREAD}`))
    await expect(p).rejects.toThrow(new RegExp(`Already sent: ${SPACE}/messages/OUT1\\.`))
  })

  test('the channel state is still not sendable', async () => {
    writeFileSync(file, 'secret')
    const w = world()
    await expect(handleReply({ chat_id: SPACE, text: 'ok', reply_to: THREAD, files: [file] }, w.deps)).rejects.toThrow(
      /refusing to send channel state/,
    )
    expect(w.created).toEqual([])
  })
})
