/**
 * Inbound: Google Chat event → `notifications/claude/channel` MCP notification.
 *
 * Emits only after the identity gate passes. Mirrors the Telegram plugin's
 * handleInbound: gate → permission-reply intercept → build meta → notify.
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { INBOX_DIR } from './config.js'
import { gate, loadAccess, markDelivered, type Role } from './access.js'
import { resolveEmail, displayUser, type Sender } from './identity.js'
import { downloadMedia } from './chat-client.js'
import type { ChatEvent } from './pubsub.js'
import { rememberDmSpace, rememberInbound } from './threading.js'

// Permission-reply spec (anthropics/claude-cli-internal): "yes/no <5 letters>".
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// The owner's DM space, learned when the owner DMs the bot. Permission prompts
// are routed here only (tighter than Telegram, which broadcasts to allowFrom).
let ownerDmSpace = ''
export function getOwnerDmSpace(): string {
  return ownerDmSpace
}

// Filenames/labels are sender-controlled and land inside the <channel> tag —
// strip delimiter chars so they can't break out or forge a second meta entry.
function safeName(s: string | undefined): string | undefined {
  return s?.replace(/[<>\[\]\r\n;]/g, '_')
}

function isBotMentioned(message: any, patterns?: string[]): boolean {
  const annotations = message?.annotations ?? []
  for (const a of annotations) {
    if (a.type === 'USER_MENTION' && a.userMention?.user?.type === 'BOT') return true
  }
  const text: string = message?.text ?? ''
  for (const pat of patterns ?? []) {
    try {
      if (new RegExp(pat, 'i').test(text)) return true
    } catch {
      // invalid user-supplied regex — skip
    }
  }
  return false
}

type FirstAttachment = {
  kind: string
  file_id: string
  size?: string
  mime?: string
  name?: string
  isImage: boolean
}

function firstAttachment(message: any): FirstAttachment | undefined {
  const list = message?.attachment ?? message?.attachments
  if (!Array.isArray(list) || list.length === 0) return undefined
  const a = list[0]
  const mime: string | undefined = a.contentType
  const isImage = !!mime && mime.startsWith('image/')
  let file_id = ''
  let kind = 'document'
  if (a.attachmentDataRef?.resourceName) {
    file_id = a.attachmentDataRef.resourceName
    kind = isImage ? 'image' : 'document'
  } else if (a.driveDataRef?.driveFileId) {
    file_id = `drive:${a.driveDataRef.driveFileId}`
    kind = 'drive'
  }
  return {
    kind,
    file_id,
    mime,
    name: safeName(a.contentName),
    isImage,
  }
}

async function eagerDownloadImage(att: FirstAttachment): Promise<string | undefined> {
  if (!att.isImage || !att.file_id || att.file_id.startsWith('drive:')) return undefined
  try {
    const buf = await downloadMedia(att.file_id)
    const ext = (att.name?.split('.').pop() ?? 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg'
    const path = join(INBOX_DIR, `${Date.now()}-img.${ext}`)
    mkdirSync(INBOX_DIR, { recursive: true })
    writeFileSync(path, buf)
    return path
  } catch (err) {
    process.stderr.write(`googlechat channel: image download failed: ${err}\n`)
    return undefined
  }
}

/**
 * Handle a single Chat event. `mcp` is the MCP Server (for .notification()).
 */
export async function handleEvent(event: ChatEvent, mcp: { notification: (n: any) => Promise<void> }): Promise<void> {
  if (event.type !== 'MESSAGE') return // ADDED/REMOVED_FROM_SPACE etc. — ack only

  const message = event.message ?? {}
  const space = event.space ?? {}
  const spaceName: string = space.name ?? message.space?.name ?? ''
  if (!spaceName) return

  const sender: Sender | undefined = message.sender
  const text: string = message.text ?? ''
  const isDM = space.type === 'DM' || space.singleUserBotDm === true
  const access = loadAccess()
  const mentioned = isBotMentioned(message, access.mentionPatterns)

  const email = await resolveEmail(sender)
  const result = gate({
    access,
    email,
    senderId: sender?.name,
    isDM,
    spaceName,
    mentioned,
  })
  if (result.action === 'drop') return

  markDelivered(spaceName)
  const role: Role = result.role
  if (isDM && role === 'owner') ownerDmSpace = spaceName

  // Permission-reply intercept: only honored from the owner DM (the replier is
  // gate-verified by Workspace identity). Emits the structured permission event
  // instead of relaying the text as a chat message.
  if (isDM && role === 'owner') {
    const m = PERMISSION_REPLY_RE.exec(text)
    if (m) {
      await mcp
        .notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: m[2]!.toLowerCase(),
            behavior: m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny',
          },
        })
        .catch(err => process.stderr.write(`googlechat channel: permission relay failed: ${err}\n`))
      return
    }
  }

  const att = firstAttachment(message)
  const imagePath = att ? await eagerDownloadImage(att) : undefined
  // Expose a non-image (or Drive) attachment lazily via attachment_file_id.
  const lazyAtt = att && !imagePath ? att : undefined

  const messageId: string | undefined = message.name
  const threadName: string | undefined = message.thread?.name
  const ts: string = message.createTime ?? new Date().toISOString()
  // So a reply that names this message (reply_to = meta.message_id) can be
  // placed in its thread without asking the API.
  rememberInbound(messageId, threadName)
  // A threaded reply in a direct message keeps the lenient reply option.
  if (isDM) rememberDmSpace(spaceName)

  await mcp
    .notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: {
          chat_id: spaceName,
          ...(messageId ? { message_id: messageId } : {}),
          user: displayUser(sender, email),
          user_id: sender?.name ?? 'unknown',
          ts,
          role, // extra passthrough — consuming agent can branch on owner/user
          ...(threadName ? { thread: threadName } : {}), // extra passthrough for reply threading
          ...(imagePath ? { image_path: imagePath } : {}),
          ...(lazyAtt
            ? {
                attachment_kind: lazyAtt.kind,
                attachment_file_id: lazyAtt.file_id,
                ...(lazyAtt.mime ? { attachment_mime: lazyAtt.mime } : {}),
                ...(lazyAtt.name ? { attachment_name: lazyAtt.name } : {}),
              }
            : {}),
        },
      },
    })
    .catch(err => {
      process.stderr.write(`googlechat channel: failed to deliver inbound to Claude: ${err}\n`)
    })
}
