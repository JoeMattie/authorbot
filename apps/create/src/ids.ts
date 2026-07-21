/**
 * UUIDv7 generation (Phase 0 contract §2, Phase 6 contract §3.2: "a real
 * UUIDv7").
 *
 * `crypto.randomUUID()` is deliberately not used: it produces a v4, whose
 * version nibble is 4 and which `authorbot validate` rejects. The layout
 * below is RFC 9562 §5.7 — 48 bits of Unix milliseconds, then the version
 * nibble, then 74 bits of randomness split by the variant bits.
 *
 *   0                   1                   2                   3
 *   |  unix_ts_ms (48 bits)             | ver | rand_a | var | rand_b |
 */
import type { Clock, RandomSource } from "./ports.js";

const HEX = "0123456789abcdef";

function hex(byte: number): string {
  return `${HEX[(byte >> 4) & 0xf] ?? "0"}${HEX[byte & 0xf] ?? "0"}`;
}

export function uuidv7(clock: Clock, random: RandomSource): string {
  const bytes = new Uint8Array(16);
  const rand = random.bytes(10);
  bytes.set(rand, 6);

  // 48-bit big-endian millisecond timestamp. Number is exact to 2^53, so the
  // shifting below is done with division rather than `>>` (which truncates to
  // 32 bits and would silently zero the high bytes until the year 2038).
  const ms = clock.now().getTime();
  const timestamp = Math.max(0, Math.floor(ms));
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Version 7 in the high nibble of octet 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // RFC 4122 variant (10xx) in the high bits of octet 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(hex(byte));
  }
  const all = parts.join("");
  return [
    all.slice(0, 8),
    all.slice(8, 12),
    all.slice(12, 16),
    all.slice(16, 20),
    all.slice(20, 32),
  ].join("-");
}

/**
 * URL-safe random token used for the manifest flow's unpredictable callback
 * path and its `state` (contract §4.1). Base64url of CSPRNG bytes — never a
 * timestamp, counter, or `Math.random()`.
 */
export function randomToken(random: RandomSource, byteLength = 32): string {
  return Buffer.from(random.bytes(byteLength)).toString("base64url");
}
