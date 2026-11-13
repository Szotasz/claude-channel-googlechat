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
