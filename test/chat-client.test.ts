/**
 * What is asked of spaces.messages.create. The request is built by a pure
 * function, so this does not call Google.
 */
import { describe, expect, test } from 'bun:test'
import './state'

const { createRequest } = await import('../src/chat-client')

const SPACE = 'spaces/AAAA1'
const THREAD = `${SPACE}/threads/TTT1`

describe('the create request', () => {
  test('a threaded message names its thread and asks to FAIL rather than open a new thread', () => {
    expect(createRequest(SPACE, 'hi', THREAD)).toEqual({
      parent: SPACE,
      messageReplyOption: 'REPLY_MESSAGE_OR_FAIL',
      requestBody: { text: 'hi', thread: { name: THREAD } },
    })
  })

  test('in a space known to be a direct message the threaded create keeps the lenient option', () => {
    expect(createRequest(SPACE, 'hi', THREAD, undefined, { directMessage: true })).toEqual({
      parent: SPACE,
      messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
      requestBody: { text: 'hi', thread: { name: THREAD } },
    })
    const att = [{ attachmentDataRef: { resourceName: 'r' } }]
    expect(createRequest(SPACE, '', THREAD, att, { directMessage: true }).messageReplyOption).toBe(
      'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
    )
  })

  test('not a direct message, said or unsaid: the strict option', () => {
    expect(createRequest(SPACE, 'hi', THREAD, undefined, { directMessage: false }).messageReplyOption).toBe(
      'REPLY_MESSAGE_OR_FAIL',
    )
    expect(createRequest(SPACE, 'hi', THREAD, undefined, {}).messageReplyOption).toBe('REPLY_MESSAGE_OR_FAIL')
  })

  test('an unthreaded message in a direct message carries no reply option either', () => {
    expect(createRequest(SPACE, 'hi', undefined, undefined, { directMessage: true })).toEqual({
      parent: SPACE,
      requestBody: { text: 'hi' },
    })
  })

  test('an unthreaded message carries no thread and no reply option', () => {
    expect(createRequest(SPACE, 'hi')).toEqual({ parent: SPACE, requestBody: { text: 'hi' } })
  })

  test('an attachment message with no text sends no text field, and is threaded the same way', () => {
    const att = [{ attachmentDataRef: { resourceName: 'r' } }]
    expect(createRequest(SPACE, '', THREAD, att)).toEqual({
      parent: SPACE,
      messageReplyOption: 'REPLY_MESSAGE_OR_FAIL',
      requestBody: { attachment: att, thread: { name: THREAD } },
    })
  })

  test('an attachment message with text keeps the text', () => {
    const att = [{ attachmentDataRef: { resourceName: 'r' } }]
    expect(createRequest(SPACE, 'see file', undefined, att).requestBody).toEqual({ text: 'see file', attachment: att })
  })

  test('an empty text message still sends the text field, as before', () => {
    expect(createRequest(SPACE, '').requestBody).toEqual({ text: '' })
  })
})
