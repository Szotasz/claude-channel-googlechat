/**
 * A sender-chosen label, made safe to show to a model.
 *
 * A Google Chat display name is text its owner picks. It ends up inside the
 * <channel> tag as meta.user, so a name with a line break, a closing bracket
 * or an invisible direction-changing character could pass for something it is
 * not. This is only ever applied to that sender-chosen text: a resolved
 * Workspace email and a users/<id> resource name come from Google and are
 * never rewritten (other code compares them exactly).
 */

export const MAX_LABEL_CHARS = 64

// Control characters, zero-width and bidirectional controls, line separators.
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g
// Characters that delimit something where the label is later shown.
const DELIMITER_RE = /[<>\[\]{}"`;\\]/g

/**
 * One line, no invisible or direction-changing characters, no delimiter that
 * could close a tag or a quote, bounded length. Compatibility forms are folded
 * first, so a full-width bracket does not slip past as "not a bracket".
 * Returns '' when nothing is left.
 */
export function cleanLabel(value: string | undefined | null): string {
  const cleaned = String(value ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE_RE, ' ')
    .replace(DELIMITER_RE, '_')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(cleaned)
  return chars.length > MAX_LABEL_CHARS ? chars.slice(0, MAX_LABEL_CHARS).join('') : cleaned
}
