/**
 * Formatting helpers for Google Chat outbound text.
 *
 * Google Chat uses its OWN inline syntax (not Telegram MarkdownV2):
 *   *bold*  _italic_  ~strike~  `code`  ```code block```  <https://url|label>
 * and bulleted lists with a leading "- " / "* ".
 *
 * Chat ALWAYS interprets these characters in message.text — there is no
 * server-side "plain mode" toggle on a basic text message. So:
 *   - format "markdownv2"/"gchat" → pass text through unchanged (the model is
 *     expected to write Google Chat formatting if it wants formatting).
 *   - format "text" → escape the active formatting characters so they render
 *     literally (best-effort).
 *
 * The `format` enum value names are kept identical to the Telegram plugin for
 * contract parity across channels; "markdownv2" simply means "treat as Chat
 * formatting" here.
 */

const CHUNK_NEWLINE = 'newline'

/** Map the tool's `format` arg to the text we actually send. */
export function toGchat(text: string, format: string | undefined): string {
  if (format === 'text') {
    // Escape Chat's active formatting characters so they show literally.
    // There is no official escape, but a zero-width-ish approach is fragile;
    // we backslash-guard the common markers, which Chat renders acceptably.
    return text.replace(/([*_~`<])/g, '\\$1')
  }
  // markdownv2 / gchat / undefined → pass through.
  return text
}

/**
 * Split a long message at Chat's per-message cap, preferring paragraph/line
 * boundaries when mode is 'newline'. Lifted from the Telegram plugin's chunk().
 */
export function chunk(text: string, limit: number, mode: 'length' | 'newline'): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = limit
    if (mode === CHUNK_NEWLINE) {
      const para = rest.lastIndexOf('\n\n', limit)
      const line = rest.lastIndexOf('\n', limit)
      const space = rest.lastIndexOf(' ', limit)
      cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit
    }
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
