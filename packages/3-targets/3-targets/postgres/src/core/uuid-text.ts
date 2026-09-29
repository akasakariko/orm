/** 32 hex digits, with at most one hyphen after each group of four but the last: the digits Postgres reads as a uuid. */
const UUID_DIGITS_PATTERN = /^(?:[0-9a-f]{4}-?){7}[0-9a-f]{4}$/i;

/**
 * A uuid as the text Postgres prints for it: lower case, hyphenated 8-4-4-4-12. Postgres also reads
 * upper case, braces, and a hyphen after any group of four digits, and stores every one of them as
 * that text. Text Postgres does not read as a uuid is returned unchanged.
 */
export function canonicalUuidText(text: string): string {
  const digits = text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text;
  if (!UUID_DIGITS_PATTERN.test(digits)) return text;
  const hex = digits.replaceAll('-', '').toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
