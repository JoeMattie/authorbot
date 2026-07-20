/**
 * UUIDv7 generation (RFC 9562): 48-bit Unix-millisecond timestamp, version
 * nibble 7, RFC 4122 variant, 74 random bits. Lowercase output matching
 * `UUIDV7_REGEX`. Uses the WebCrypto global (Node >= 19 and Workers).
 */

const HEX = "0123456789abcdef";

/** Generate a fresh lowercase UUIDv7. `timestamp` overridable for tests. */
export function generateUuidv7(timestamp: number = Date.now()): string {
  if (!Number.isInteger(timestamp) || timestamp < 0 || timestamp >= 2 ** 48) {
    throw new RangeError("uuidv7 timestamp must be a 48-bit non-negative integer");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);

  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  let hex = "";
  for (let i = 0; i < 16; i += 1) {
    const b = bytes[i] ?? 0;
    hex += HEX.charAt(b >> 4) + HEX.charAt(b & 0x0f);
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
