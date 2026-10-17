// Cutting text to a limit without leaving half a character behind. A string
// is UTF-16: an emoji or any other astral character is two code units, and a
// cut between them leaves a lone surrogate, which Postgres refuses in jsonb
// (run events, review checks) and JSON prints as \udXXX. Every cut here moves
// off the middle of a pair, and the result is made well formed (a lone half
// already in the source becomes U+FFFD), so it stays within its limit as the
// board's schemas count it.

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The start of `text` in at most `max` code units; a cut one ends in `suffix`, inside the limit. */
export function clip(text: string, max: number, suffix = ""): string {
  if (text.length <= max) return text.toWellFormed();
  let end = Math.max(0, max - suffix.length);
  if (end > 0 && isHigh(text.charCodeAt(end - 1))) end -= 1;
  return `${text.slice(0, end)}${suffix}`.toWellFormed();
}

/** The end of `text` in at most `max` code units; a cut one starts with `prefix`, inside the limit. */
export function tail(text: string, max: number, prefix = ""): string {
  if (text.length <= max) return text.toWellFormed();
  let start = text.length - Math.max(0, max - prefix.length);
  if (start < text.length && isLow(text.charCodeAt(start))) start += 1;
  return `${prefix}${text.slice(start)}`.toWellFormed();
}
