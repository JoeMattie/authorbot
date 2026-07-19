import { expect } from "vitest";
import type { z } from "zod";

export function expectValid(schema: z.ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `expected value to be valid, got issues:\n${JSON.stringify(result.error.issues, null, 2)}`,
    );
  }
  expect(result.success).toBe(true);
}

export function expectInvalid(schema: z.ZodType, value: unknown): void {
  const result = schema.safeParse(value);
  expect(result.success).toBe(false);
}

/** Deep-clone a sample so tests can mutate it freely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function clone<T>(value: T): any {
  return structuredClone(value);
}
