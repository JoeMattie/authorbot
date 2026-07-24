/** Accessible two-view switcher for the Outline and Chapter summaries page. */
export class AuthorbotStoryViewTabs extends HTMLElement {
  private connected = false;

  connectedCallback(): void {
    if (this.connected) return;
    const tablist = Array.from(this.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.getAttribute("role") === "tablist",
    );
    const tabs = tablist === undefined
      ? []
      : Array.from(tablist.children).filter(
          (child): child is HTMLButtonElement =>
            child instanceof HTMLButtonElement && child.getAttribute("role") === "tab",
        );
    const panels = new Map(
      Array.from(this.children)
        .filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement && child.getAttribute("role") === "tabpanel",
        )
        .map((panel) => [panel.id, panel]),
    );
    if (tabs.length === 0 || panels.size === 0) return;
    this.connected = true;

    const activate = (tab: HTMLButtonElement, focus = false): void => {
      for (const candidate of tabs) {
        const selected = candidate === tab;
        candidate.setAttribute("aria-selected", String(selected));
        candidate.tabIndex = selected ? 0 : -1;
        const panelId = candidate.getAttribute("aria-controls");
        const panel = panelId === null ? undefined : panels.get(panelId);
        if (panel !== undefined) panel.hidden = !selected;
      }
      if (focus) tab.focus();
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activate(tab));
      tab.addEventListener("keydown", (event) => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault();
        activate(tabs[next] as HTMLButtonElement, true);
      });
    });

    activate(
      tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0]!,
    );
  }
}

if (customElements.get("authorbot-story-view-tabs") === undefined) {
  customElements.define("authorbot-story-view-tabs", AuthorbotStoryViewTabs);
}
