/**
 * UUIDv7 generation (Phase 0 contract §2: entity ids are UUIDv7, lowercase).
 * WebCrypto only (`crypto.getRandomValues`), so it runs identically in Node
 * and Cloudflare Workers. Within one millisecond ids stay monotonic by using
 * the 12-bit `rand_a` field as a sequence counter — cursor pagination orders
 * by id (Phase 2 contract §4 / design §15.1), so creation order must sort.
 */

let lastMillis = -1;
let sequence = 0;

export function uuidv7(now: Date = new Date()): string {
  let millis = now.getTime();
  if (millis > lastMillis) {
    lastMillis = millis;
    // Random starting point in the lower half of the 12-bit space keeps
    // room to count up without overflow.
    const seed = new Uint16Array(1);
    crypto.getRandomValues(seed);
    sequence = (seed[0] as number) & 0x07ff;
  } else {
    // Same millisecond (or a clock step backwards): never emit an id that
    // sorts before the previous one.
    millis = lastMillis;
    sequence += 1;
    if (sequence > 0x0fff) {
      millis += 1;
      lastMillis = millis;
      sequence = 0;
    }
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit big-endian millisecond timestamp.
  const ts = BigInt(millis);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  // Version 7 in the high nibble; rand_a = sequence.
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  // RFC 9562 variant (10xx).
  bytes[8] = (0x80 | ((bytes[8] as number) & 0x3f)) & 0xff;

  const hex: string[] = [];
  for (const byte of bytes) {
    hex.push(byte.toString(16).padStart(2, "0"));
  }
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
