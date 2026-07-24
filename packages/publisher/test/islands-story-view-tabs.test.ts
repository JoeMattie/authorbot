// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { AuthorbotStoryViewTabs } from "../site/src/islands/story-view-tabs.js";

if (customElements.get("authorbot-story-view-tabs") === undefined) {
  customElements.define("authorbot-story-view-tabs", AuthorbotStoryViewTabs);
}

function mount(): AuthorbotStoryViewTabs {
  const host = document.createElement("authorbot-story-view-tabs") as AuthorbotStoryViewTabs;
  host.innerHTML = `
      <div role="tablist" aria-label="Outline views">
        <button role="tab" aria-selected="true" aria-controls="outline">Outline</button>
        <button role="tab" aria-selected="false" aria-controls="summaries" tabindex="-1">
          Chapter summaries
        </button>
      </div>
      <section id="outline" role="tabpanel">Outline content</section>
      <section id="summaries" role="tabpanel" hidden>Summary content</section>
  `;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("story view tabs", () => {
  it("switches between Outline and Chapter summaries without showing both", () => {
    const host = mount();
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const panels = host.querySelectorAll<HTMLElement>('[role="tabpanel"]');

    tabs[1]?.click();

    expect(tabs[0]?.getAttribute("aria-selected")).toBe("false");
    expect(tabs[0]?.tabIndex).toBe(-1);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.tabIndex).toBe(0);
    expect(panels[0]?.hidden).toBe(true);
    expect(panels[1]?.hidden).toBe(false);
  });

  it("supports wrapping arrow navigation and Home/End", () => {
    const host = mount();
    const tabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]');

    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);

    tabs[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);

    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
  });
});
