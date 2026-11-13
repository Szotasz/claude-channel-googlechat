/**
 * Thin wrapper around the Google Chat REST API (@googleapis/chat). Isolates the
 * googleapis specifics from tools.ts / inbound.ts. Auth is the app service
 * account with the chat.bot scope.
 */
import { createReadStream } from 'fs'
import { basename } from 'path'
import { GoogleAuth } from 'google-auth-library'
import { chat as chatApi } from '@googleapis/chat'
import { KEY_FILE, CHAT_SCOPE } from './config.js'

let client: ReturnType<typeof chatApi> | null = null

function chat() {
  if (client) return client
  const auth = new GoogleAuth({ keyFile: KEY_FILE, scopes: [CHAT_SCOPE] })
  client = chatApi({ version: 'v1', auth: auth as any })
  return client
}

export type SentMessage = { name: string }

/**
 * How a threaded create behaves when the thread cannot be replied to.
 * REPLY_MESSAGE_OR_FAIL returns NOT_FOUND instead of starting a new thread
 * (google.chat.v1.CreateMessageRequest.MessageReplyOption). The fallback
 * variant used before made a wrong thread name look like a sent reply.
 *
 * The option is documented as "only supported in named spaces", and what a
 * direct message space does with the strict one has not been measured here.
 * If a DM rejected it, every threaded reply in a DM would fail, the owner's
 * included. So a space known to be a DM keeps the variant it always had; the
 * caller says which (CreateOptions.directMessage). Once a DM is measured to
 * accept REPLY_MESSAGE_OR_FAIL, THREADED_REPLY_DM can become the same value.
 */
const THREADED_REPLY = 'REPLY_MESSAGE_OR_FAIL'
const THREADED_REPLY_DM = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'

export type CreateOptions = {
  /** The space is known to be a direct message: a threaded create may fall back to a new thread. */
  directMessage?: boolean
}

/**
 * The spaces.messages.create request for a text and/or attachment message.
 * Pure, so what is asked of the API can be tested without calling it: a
 * threaded message names its thread AND asks to fail rather than fall back.
 */
export function createRequest(
  space: string,
  text: string,
  threadName?: string,
  attachments?: any[],
  opts: CreateOptions = {},
) {
  return {
    parent: space,
    ...(threadName ? { messageReplyOption: opts.directMessage ? THREADED_REPLY_DM : THREADED_REPLY } : {}),
    requestBody: {
      ...(text || !attachments ? { text } : {}),
      ...(attachments ? { attachment: attachments } : {}),
      ...(threadName ? { thread: { name: threadName } } : {}),
    },
  }
}

/** Create a message in a space, optionally threaded. Returns the new message name. */
export async function createMessage(
  space: string,
  text: string,
  threadName?: string,
  opts: CreateOptions = {},
): Promise<SentMessage> {
  const res = await chat().spaces.messages.create(createRequest(space, text, threadName, undefined, opts))
  return { name: res.data.name ?? '' }
}

/** Create a message that carries one or more already-uploaded attachments. */
export async function createMessageWithAttachments(
  space: string,
  text: string,
  attachments: any[],
  threadName?: string,
  opts: CreateOptions = {},
): Promise<SentMessage> {
  const res = await chat().spaces.messages.create(createRequest(space, text, threadName, attachments, opts))
  return { name: res.data.name ?? '' }
}

/**
 * The thread a message is in, or undefined when it has none. With the app's
 * chat.bot scope this answers only for messages the app has access to; the
 * caller treats a failure as "could not resolve", never as "no thread".
 */
export async function getMessageThread(name: string): Promise<string | undefined> {
  const res = await chat().spaces.messages.get({ name })
  return res.data.thread?.name ?? undefined
}

/** Patch the text of a message the app previously sent. */
export async function patchMessage(name: string, text: string): Promise<SentMessage> {
  const res = await chat().spaces.messages.patch({
    name,
    updateMask: 'text',
    requestBody: { text },
  })
  return { name: res.data.name ?? name }
}

/** Add an emoji reaction. Best-effort: app reactions are often restricted. */
export async function createReaction(messageName: string, emoji: string): Promise<void> {
  await chat().spaces.messages.reactions.create({
    parent: messageName,
    requestBody: { emoji: { unicode: emoji } },
  })
}

/**
 * Upload a local file as a Chat attachment, returning the attachment object to
 * embed in a message. May be unavailable depending on app config — callers
 * should catch and degrade.
 */
export async function uploadAttachment(space: string, filePath: string, mimeType: string): Promise<any> {
  const res = await chat().media.upload({
    parent: space,
    requestBody: { filename: basename(filePath) },
    media: { mimeType, body: createReadStream(filePath) },
  })
  const ref = (res.data as any).attachmentDataRef
  return { attachmentDataRef: ref }
}

/** Download an uploaded attachment's bytes by its resourceName (media.download). */
export async function downloadMedia(resourceName: string): Promise<Buffer> {
  const res = await chat().media.download(
    { resourceName, alt: 'media' },
    { responseType: 'arraybuffer' },
  )
  return Buffer.from(res.data as ArrayBuffer)
}
