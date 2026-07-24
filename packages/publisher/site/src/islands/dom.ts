/**
 * Tiny DOM helpers shared by the Phase 3 islands (vote control, work queue).
 * Every text path goes through `textContent` - `innerHTML` is never used, so
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

export type InlineIconName =
  | "chevron-up"
  | "check"
  | "history"
  | "maximize"
  | "note"
  | "panel-right"
  | "pencil"
  | "trash"
  | "x";

const ICON_PATHS: Record<InlineIconName, readonly string[]> = {
  "chevron-up": ["M18 15l-6-6-6 6"],
  check: ["M20 6 9 17l-5-5"],
  history: ["M3 12a9 9 0 1 0 3-6.7", "M3 3v6h6", "M12 7v5l3 2"],
  maximize: [
    "M8 3H5a2 2 0 0 0-2 2v3",
    "M16 3h3a2 2 0 0 1 2 2v3",
    "M8 21H5a2 2 0 0 1-2-2v-3",
    "M16 21h3a2 2 0 0 0 2-2v-3",
  ],
  note: [
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z",
    "M14 2v6h6",
    "M8 13h8",
    "M8 17h5",
  ],
  "panel-right": [
    "M3 3h18v18H3Z",
    "M15 3v18",
  ],
  pencil: [
    "M12 20h9",
    "M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z",
  ],
  trash: [
    "M3 6h18",
    "M8 6V4h8v2",
    "M19 6l-1 14H6L5 6",
    "M10 11v5",
    "M14 11v5",
  ],
  x: ["M18 6 6 18", "M6 6l12 12"],
};

/** CSP-safe inline icon assembled through DOM APIs, never HTML injection. */
export function inlineIcon(name: InlineIconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("ab-inline-icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const data of ICON_PATHS[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}

/** Compact icon-only button with an accessible name and hover tooltip. */
export function iconButton(
  className: string,
  label: string,
  icon: InlineIconName,
): HTMLButtonElement {
  const button = el("button", className);
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(inlineIcon(icon));
  return button;
}

/** Replace a button label without losing its decorative leading icon. */
export function setLabeledButton(
  button: HTMLButtonElement,
  label: string,
  icon: InlineIconName,
): void {
  button.classList.add("ab-labeled-icon");
  button.replaceChildren(inlineIcon(icon), document.createTextNode(label));
}

/** Text button with a decorative leading icon and an ordinary accessible name. */
export function labeledButton(
  className: string,
  label: string,
  icon: InlineIconName,
): HTMLButtonElement {
  const button = el("button", className);
  button.type = "button";
  setLabeledButton(button, label, icon);
  return button;
}
