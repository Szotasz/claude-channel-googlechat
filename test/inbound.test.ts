/**
 * The inbound side of reply threading: a delivered message is remembered with
 * its thread, so a reply that names the message can be placed without the API.
 * The event is built from the fields src/inbound.ts reads, not recorded from
 * Google.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { STATE } from './state'

const { handleEvent } = await import('../src/inbound')
const { forgetInbounds, isKnownDm, rememberedThread } = await import('../src/threading')
const { handleReply } = await import('../src/tools')

const SPACE = 'spaces/DM1'
const THREAD = `${SPACE}/threads/TTT1`
const MESSAGE = `${SPACE}/messages/MMM1.MMM1`
const OWNER = 'owner@example.com'

function event(over: Record<string, unknown> = {}): any {
  return {
    type: 'MESSAGE',
    space: { name: SPACE, type: 'DM' },
    message: {
      name: MESSAGE,
      text: 'hello',
      sender: { name: 'users/100', email: OWNER },
      thread: { name: THREAD },
      createTime: '2026-01-01T00:00:00Z',
      ...over,
    },
  }
}

function channel() {
  const sent: any[] = []
  return { sent, mcp: { notification: async (n: any) => void sent.push(n) } }
}

beforeEach(() => {
  forgetInbounds()
  writeFileSync(
    join(STATE, 'access.json'),
    JSON.stringify({ policy: 'allowlist', owner: OWNER, allowFrom: [], allowDomains: [], roles: {}, spaces: {} }),
  )
})

describe('a delivered inbound', () => {
  test('carries its thread in the meta, and is remembered with it', async () => {
    const c = channel()
    await handleEvent(event(), c.mcp)
    expect(c.sent.length).toBe(1)
    expect(c.sent[0].params.meta.thread).toBe(THREAD)
    expect(c.sent[0].params.meta.message_id).toBe(MESSAGE)
    expect(rememberedThread(MESSAGE)).toBe(THREAD)
  })

  test('so a reply that names the message goes into its thread, without asking the API', async () => {
    const c = channel()
    await handleEvent(event(), c.mcp)
    const created: Array<string | undefined> = []
    await handleReply(
      { chat_id: SPACE, text: 'ok', reply_to: MESSAGE },
      {
        assertAllowedChat: () => {},
        loadAccess: () => ({ spaces: {} }) as any,
        createMessage: async (_s, _t, thread) => {
          created.push(thread)
          return { name: `${SPACE}/messages/OUT1` }
        },
        createMessageWithAttachments: async () => ({ name: '' }),
        uploadAttachment: async () => ({}),
        getMessageThread: async () => {
          throw new Error('the API was asked')
        },
      },
    )
    expect(created).toEqual([THREAD])
  })

  test('a message with no thread is delivered and not remembered', async () => {
    const c = channel()
    await handleEvent(event({ thread: undefined }), c.mcp)
    expect(c.sent.length).toBe(1)
    expect('thread' in c.sent[0].params.meta).toBe(false)
    expect(rememberedThread(MESSAGE)).toBeUndefined()
  })

  test('a delivered direct message marks its space as a direct message', async () => {
    expect(isKnownDm(SPACE)).toBe(false)
    await handleEvent(event(), channel().mcp)
    expect(isKnownDm(SPACE)).toBe(true)
  })

  test('a delivered message of a named space does not', async () => {
    const ROOM = 'spaces/ROOM1'
    writeFileSync(
      join(STATE, 'access.json'),
      JSON.stringify({
        policy: 'allowlist',
        owner: OWNER,
        allowFrom: [],
        allowDomains: [],
        roles: {},
        spaces: { [ROOM]: { requireMention: false } },
      }),
    )
    const c = channel()
    await handleEvent(
      { type: 'MESSAGE', space: { name: ROOM, type: 'ROOM' }, message: { ...event().message, name: `${ROOM}/messages/M1` } },
      c.mcp,
    )
    expect(c.sent.length).toBe(1)
    expect(isKnownDm(ROOM)).toBe(false)
  })

  test('a direct message the gate drops does not mark its space', async () => {
    await handleEvent(event({ sender: { name: 'users/999', email: 'stranger@example.com' } }), channel().mcp)
    expect(isKnownDm(SPACE)).toBe(false)
  })

  test('a message the gate drops is not remembered', async () => {
    const c = channel()
    await handleEvent(event({ sender: { name: 'users/999', email: 'stranger@example.com' } }), c.mcp)
    expect(c.sent).toEqual([])
    expect(rememberedThread(MESSAGE)).toBeUndefined()
  })
})
