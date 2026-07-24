import "@awesome.me/webawesome/dist/styles/webawesome.css";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import WaDrawer from "@awesome.me/webawesome/dist/components/drawer/drawer.js";
import "../styles/character-drawer.css";

export function initializeCharacterDrawer(): void {
  // Keep this constructor in the browser bundle as a runtime value. When the
  // published package is built from an author's checkout, Authorbot's
  // tsconfig is not present and Vite can otherwise erase this import as
  // type-only. Web Awesome normally self-registers through its decorator; the
  // guarded definition also makes the boundary explicit and resilient.
  if (customElements.get("wa-drawer") === undefined) {
    customElements.define("wa-drawer", WaDrawer);
  }

  const drawer = document.querySelector<WaDrawer>("[data-character-drawer]");
  if (drawer === null || drawer.dataset.ready === "true") return;
  drawer.dataset.ready = "true";

  const content = drawer.querySelector<HTMLElement>("[data-character-drawer-content]");
  const title = drawer.querySelector<HTMLElement>("[data-character-drawer-title]");
  const pageLink = drawer.querySelector<HTMLAnchorElement>("[data-character-drawer-page]");
  if (content === null || title === null || pageLink === null) return;

  let request: AbortController | null = null;

  drawer.addEventListener("wa-hide", () => {
    request?.abort();
    request = null;
  });
  drawer.addEventListener("wa-after-hide", () => {
    // Web Awesome owns scroll locking. Re-measure anchored side content after
    // it restores the document scrollport.
    requestAnimationFrame(() => globalThis.dispatchEvent(new Event("resize")));
  });

  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-character-drawer-link]")) {
    link.addEventListener("click", (event) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      void openCharacter(link, drawer, content, title, pageLink, (next) => {
        request?.abort();
        request = next;
      });
    });
  }
}

async function openCharacter(
  link: HTMLAnchorElement,
  drawer: WaDrawer,
  content: HTMLElement,
  title: HTMLElement,
  pageLink: HTMLAnchorElement,
  setRequest: (request: AbortController | null) => void,
): Promise<void> {
  const href = link.href;
  title.textContent = link.textContent?.trim() || "Character details";
  pageLink.href = href;
  content.textContent = "Loading character details…";
  content.setAttribute("role", "status");
  const controller = new AbortController();
  setRequest(controller);

  if (!drawer.open) {
    drawer.open = true;
  }

  try {
    const response = await fetch(href, { signal: controller.signal });
    if (!response.ok) throw new Error(`Character page returned ${String(response.status)}`);
    const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
    const detail = parsed.querySelector<HTMLElement>(".character-detail");
    if (detail === null) throw new Error("Character details were missing");
    detail.querySelector(".character-back-link")?.remove();
    detail.querySelector("authorbot-planning-document-editor")?.remove();
    resolveRelativeLinks(detail, response.url || href);
    content.removeAttribute("role");
    content.replaceChildren(document.importNode(detail, true));
  } catch (error) {
    if (controller.signal.aborted) return;
    content.setAttribute("role", "alert");
    content.replaceChildren(
      document.createTextNode("Character details could not load. "),
      pageLink.cloneNode(true),
    );
  } finally {
    setRequest(null);
  }
}

function resolveRelativeLinks(root: HTMLElement, base: string): void {
  for (const element of root.querySelectorAll<HTMLElement>("[href], [src]")) {
    for (const attribute of ["href", "src"] as const) {
      const value = element.getAttribute(attribute);
      if (value === null || value.startsWith("#")) continue;
      try {
        element.setAttribute(attribute, new URL(value, base).href);
      } catch {
        // Keep malformed source inert and unchanged.
      }
    }
  }
}
