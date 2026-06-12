/**
 * Outbound MCP tools. Names and shapes are IDENTICAL to the Telegram plugin
 * (reply / react / edit_message / download_attachment) so the host and agents
 * treat every channel uniformly; only the internals target the Chat API.
 */
import { writeFileSync, mkdirSync, statSync, realpathSync } from 'fs'
import { join, sep, extname } from 'path'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { STATE_DIR, INBOX_DIR, MAX_CHUNK_LIMIT, MAX_ATTACHMENT_BYTES } from './config.js'
import { loadAccess, assertAllowedChat } from './access.js'
import { toGchat, chunk } from './gchat-format.js'
import {
  createMessage,
  createMessageWithAttachments,
  patchMessage,
  createReaction,
  uploadAttachment,
  downloadMedia,
} from './chat-client.js'

// Refuse to ship the server's own state (e.g. sa-key.json, .env, access.json).
// inbox/ is allowed — that's where downloads land.
function assertSendable(f: string): void {
  let real: string, stateReal: string
  try {
    real = realpathSync(f)
    stateReal = realpathSync(STATE_DIR)
  } catch {
    return
  }
  const inbox = join(stateReal, 'inbox')
  if (real.startsWith(stateReal + sep) && !real.startsWith(inbox + sep)) {
    throw new Error(`refusing to send channel state: ${f}`)
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
}
function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

const FORMAT_DESC =
  "Rendering mode. 'markdownv2' (alias for Google Chat formatting) sends *bold* _italic_ `code` <url|label> as-is; 'text' escapes those so they render literally. Default: 'text'."

export function registerTools(mcp: any): void {
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Reply on Google Chat. Pass chat_id (the space resource name, e.g. spaces/AAAA) from the inbound message. Optionally pass reply_to (a thread name, e.g. the inbound meta.thread) to thread the reply, and files (absolute paths) to attach.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'Space resource name, e.g. spaces/AAAA (from inbound meta.chat_id)' },
            text: { type: 'string' },
            reply_to: {
              type: 'string',
              description: 'Thread resource name to reply under (use meta.thread from the inbound block). Omit for a new thread.',
            },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Absolute file paths to attach. Max 50MB each. Attachment upload may be unavailable depending on app config.',
            },
            format: { type: 'string', enum: ['text', 'markdownv2'], description: FORMAT_DESC },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'react',
        description:
          'Add an emoji reaction to a Google Chat message. Best-effort: app reactions are restricted in many Workspace configs and may be rejected.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string', description: 'Message resource name, e.g. spaces/AAAA/messages/BBBB' },
            emoji: { type: 'string', description: 'A single unicode emoji' },
          },
          required: ['chat_id', 'message_id', 'emoji'],
        },
      },
      {
        name: 'download_attachment',
        description:
          'Download a file attachment from a Google Chat message to the local inbox. Use when the inbound <channel> meta shows attachment_file_id. Returns the local path ready to Read. Drive-file attachments are not supported in this version.',
        inputSchema: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'The attachment_file_id from inbound meta' },
          },
          required: ['file_id'],
        },
      },
      {
        name: 'edit_message',
        description:
          "Edit a message the bot previously sent (interim progress updates). Only the app's own messages can be edited, and edits can't be chunked.",
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string' },
            message_id: { type: 'string', description: 'Message resource name, e.g. spaces/AAAA/messages/BBBB' },
            text: { type: 'string' },
            format: { type: 'string', enum: ['text', 'markdownv2'], description: FORMAT_DESC },
          },
          required: ['chat_id', 'message_id', 'text'],
        },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req: any) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    try {
      switch (req.params.name) {
        case 'reply':
          return await handleReply(args)
        case 'react':
          return await handleReact(args)
        case 'download_attachment':
          return await handleDownload(args)
        case 'edit_message':
          return await handleEdit(args)
        default:
          return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
    }
  })
}

async function handleReply(args: Record<string, unknown>) {
  const chat_id = args.chat_id as string
  const text = (args.text as string) ?? ''
  const reply_to = args.reply_to != null ? String(args.reply_to) : undefined
  const files = (args.files as string[] | undefined) ?? []
  const format = (args.format as string | undefined) ?? 'text'

  assertAllowedChat(chat_id)
  for (const f of files) {
    assertSendable(f)
    const st = statSync(f)
    if (st.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`file too large: ${f} (${(st.size / 1024 / 1024).toFixed(1)}MB, max 50MB)`)
    }
  }

  const access = loadAccess()
  const limit = Math.max(1, Math.min(access.textChunkLimit ?? MAX_CHUNK_LIMIT, MAX_CHUNK_LIMIT))
  const mode = access.chunkMode ?? 'length'
  const replyMode = access.replyToMode ?? 'first'
  // Only thread when reply_to is a thread resource name.
  const thread = reply_to && reply_to.includes('/threads/') ? reply_to : undefined
  const body = toGchat(text, format)
  const chunks = chunk(body, limit, mode)
  const sentIds: string[] = []

  for (let i = 0; i < chunks.length; i++) {
    const useThread = thread && replyMode !== 'off' && (replyMode === 'all' || i === 0) ? thread : undefined
    const sent = await createMessage(chat_id, chunks[i], useThread)
    sentIds.push(sent.name)
  }

  // Attachments go as a trailing message. Upload is best-effort; on failure we
  // post a text note rather than failing the whole reply.
  if (files.length > 0) {
    try {
      const uploaded: any[] = []
      for (const f of files) uploaded.push(await uploadAttachment(chat_id, f, mimeFor(f)))
      const sent = await createMessageWithAttachments(chat_id, '', uploaded, thread)
      sentIds.push(sent.name)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const note = await createMessage(chat_id, `(attachment upload unavailable: ${msg})`, thread)
      sentIds.push(note.name)
    }
  }

  const result =
    sentIds.length === 1 ? `sent (id: ${sentIds[0]})` : `sent ${sentIds.length} parts (ids: ${sentIds.join(', ')})`
  return { content: [{ type: 'text', text: result }] }
}

async function handleReact(args: Record<string, unknown>) {
  assertAllowedChat(args.chat_id as string)
  try {
    await createReaction(args.message_id as string, args.emoji as string)
    return { content: [{ type: 'text', text: 'reacted' }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Non-fatal: reactions are best-effort on Google Chat.
    return { content: [{ type: 'text', text: `reaction not supported here: ${msg}` }], isError: true }
  }
}

async function handleEdit(args: Record<string, unknown>) {
  assertAllowedChat(args.chat_id as string)
  const text = toGchat(args.text as string, (args.format as string | undefined) ?? 'text')
  if (text.length > MAX_CHUNK_LIMIT) {
    throw new Error(`edit text exceeds ${MAX_CHUNK_LIMIT} chars and cannot be chunked`)
  }
  const edited = await patchMessage(args.message_id as string, text)
  return { content: [{ type: 'text', text: `edited (id: ${edited.name})` }] }
}

async function handleDownload(args: Record<string, unknown>) {
  const file_id = args.file_id as string
  if (file_id.startsWith('drive:')) {
    return {
      content: [{ type: 'text', text: 'download_attachment: Drive-file attachments are not supported in this version' }],
      isError: true,
    }
  }
  const buf = await downloadMedia(file_id)
  const safe = file_id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-40) || 'dl'
  const path = join(INBOX_DIR, `${Date.now()}-${safe}`)
  mkdirSync(INBOX_DIR, { recursive: true })
  writeFileSync(path, buf)
  return { content: [{ type: 'text', text: path }] }
}
