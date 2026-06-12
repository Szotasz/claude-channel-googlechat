/**
 * Cloud Pub/Sub PULL consumer — the inbound transport, replacing Telegram's
 * getUpdates long-poll. Google Chat publishes events to a topic; we subscribe
 * with a PULL subscription (works behind a firewall, no public URL).
 *
 * SINGLE-CONSUMER WARNING (the getUpdates 409 analog): multiple subscribers on
 * ONE subscription LOAD-BALANCE — two sessions pulling the same subscription
 * each get ~half the messages, silently. The contract is therefore ONE
 * SUBSCRIPTION PER AGENT/SESSION (Pub/Sub fans out a full copy per
 * subscription). A local PID lock (in server.ts) defends the same machine; only
 * distinct subscriptions protect across machines. See SETUP.md.
 */
import { PubSub, type Message } from '@google-cloud/pubsub'
import { PROJECT_ID, KEY_FILE, SUBSCRIPTION } from './config.js'

export type ChatEvent = {
  type?: string
  space?: { name?: string; type?: string; singleUserBotDm?: boolean }
  message?: any
  user?: any
}

/**
 * Start pulling. `onEvent` is invoked per message. We ALWAYS ack after handling
 * (success or drop): a chat bridge prefers a lost message over a poison
 * redelivery loop, and dropped (un-allowlisted) messages must not be nacked.
 * Transient outbound errors are handled inside the tools, not here.
 * Returns a close function for graceful shutdown.
 */
export function startPubSub(onEvent: (event: ChatEvent) => Promise<void>): () => void {
  const pubsub = new PubSub({ projectId: PROJECT_ID, keyFilename: KEY_FILE })
  const subscription = pubsub.subscription(SUBSCRIPTION, {
    flowControl: { maxMessages: 1 }, // serial delivery → no interleaved notifications
  })

  subscription.on('message', async (msg: Message) => {
    try {
      const event = JSON.parse(msg.data.toString('utf8')) as ChatEvent
      await onEvent(event)
    } catch (err) {
      process.stderr.write(`googlechat channel: inbound handler error: ${err}\n`)
    } finally {
      msg.ack()
    }
  })

  subscription.on('error', err => {
    // Log and keep the subscription object alive; the client auto-reconnects the
    // streaming pull. Don't exit — MCP tools must stay alive even if inbound is
    // temporarily broken ("deaf but alive").
    process.stderr.write(`googlechat channel: subscription error: ${err}\n`)
  })

  process.stderr.write(`googlechat channel: pulling subscription ${SUBSCRIPTION}\n`)

  let closed = false
  return () => {
    if (closed) return
    closed = true
    void subscription.close().catch(() => {})
  }
}
