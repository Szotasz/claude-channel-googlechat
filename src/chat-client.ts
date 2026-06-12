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

/** Create a message in a space, optionally threaded. Returns the new message name. */
export async function createMessage(
  space: string,
  text: string,
  threadName?: string,
): Promise<SentMessage> {
  const res = await chat().spaces.messages.create({
    parent: space,
    ...(threadName ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' } : {}),
    requestBody: {
      text,
      ...(threadName ? { thread: { name: threadName } } : {}),
    },
  })
  return { name: res.data.name ?? '' }
}

/** Create a message that carries one or more already-uploaded attachments. */
export async function createMessageWithAttachments(
  space: string,
  text: string,
  attachments: any[],
  threadName?: string,
): Promise<SentMessage> {
  const res = await chat().spaces.messages.create({
    parent: space,
    ...(threadName ? { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' } : {}),
    requestBody: {
      ...(text ? { text } : {}),
      attachment: attachments,
      ...(threadName ? { thread: { name: threadName } } : {}),
    },
  })
  return { name: res.data.name ?? '' }
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
    { resourceName },
    { responseType: 'arraybuffer' },
  )
  return Buffer.from(res.data as ArrayBuffer)
}
