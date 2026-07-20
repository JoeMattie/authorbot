/**
 * Tiny DOM helpers shared by the Phase 3 islands (vote control, work queue).
 * Every text path goes through `textContent` — `innerHTML` is never used, so
 * the contract §3 plain-text / CSP guarantees hold (asserted by the build
 * test: the bundle must not contain "innerHTML").
 */

/** createElement + optional class + optional (plain-text) content. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

/** A visually-hidden label for assistive technology. */
export function srOnly(text: string): HTMLSpanElement {
  return el("span", "ab-sr", text);
}
