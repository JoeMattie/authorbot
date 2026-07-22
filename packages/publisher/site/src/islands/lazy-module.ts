/** One initial request plus one retry for a transient split-chunk failure. */
export const LAZY_MODULE_ATTEMPTS = 2;

/**
 * Request a browser-only module with a deliberately small retry budget.
 *
 * Split chunks can fail once while a deployment is changing underneath an
 * already-open page. A second request recovers that case without letting each
 * island start an unbounded retry loop when the failure is permanent.
 */
export async function loadLazyModule<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= LAZY_MODULE_ATTEMPTS; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt === LAZY_MODULE_ATTEMPTS) {
        throw error;
      }
    }
  }

  // The loop always returns or throws. Keep the impossible path explicit so
  // TypeScript does not widen the public result with `undefined`.
  throw new Error("lazy module retry budget was empty");
}
