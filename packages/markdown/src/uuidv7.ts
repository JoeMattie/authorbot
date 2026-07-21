/**
 * Local UUIDv7 check (contract section 2): lowercase, version nibble `7`,
 * RFC 4122 variant nibble (`8`, `9`, `a`, or `b`).
 *
 * Deliberately duplicated from `@authorbot/schemas` - this package must not
 * depend on the schemas package (schema validation happens in the CLI).
 */
export const UUIDV7_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Returns true when `value` is a lowercase UUIDv7. */
export function isUuidv7(value: string): boolean {
  return UUIDV7_REGEX.test(value);
}
