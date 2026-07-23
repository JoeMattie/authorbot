// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  createManuscriptSurface,
  ProseMirrorChapterNotesAdapter,
  UnsafeManuscriptError,
  validateManuscriptMarkdown,
} from "../site/src/islands/milkdown-manuscript-surface.js";

const SOURCE = [
  "A **quiet** first paragraph with [a safe link](https://example.com).",
  "",
  "- one",
  "- two",
  "",
  "> A final observation.",
].join("\n");

const BLOCKS = ["019cadfe-7360-7049-a30b-1f5898a5020a", "019cadfe-7360-7049-a30b-1f5898a5020b", "019cadfe-7360-7049-a30b-1f5898a5020c"];

afterEach(() => document.body.replaceChildren());

describe("Milkdown manuscript surface", () => {
  it("round-trips safe Markdown through Crepe and keeps note state out of the document", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const first = await createManuscriptSurface({
      root,
      markdown: SOURCE,
      blockIds: BLOCKS,
      activation: "edit",
      accessibleName: "Chapter text for Loose Ends",
    });

    expect(root.querySelector('[role="textbox"]')?.getAttribute("aria-label"))
      .toBe("Chapter text for Loose Ends");
    expect(first.notes).toBeInstanceOf(ProseMirrorChapterNotesAdapter);
    first.notes.setPreview(BLOCKS[0]!, true);
    expect(first.notes.elementFor(BLOCKS[0]!)?.classList.contains("ab-note-target-preview"))
      .toBe(true);
    const note = document.createElement("aside");
    note.textContent = "Review this beat.";
    first.notes.mountInlineNote(BLOCKS[0]!, note);
    const composer = document.createElement("form");
    composer.textContent = "Compose beside this beat.";
    first.notes.mountInlineNote(BLOCKS[0]!, composer);
    expect(root.textContent).toContain("Review this beat.");
    expect(root.textContent?.indexOf("Compose beside this beat.")).toBeLessThan(
      root.textContent?.indexOf("Review this beat.") ?? 0,
    );
    const replacement = document.createElement("form");
    replacement.textContent = "Replacement composer.";
    first.notes.mountInlineNote(BLOCKS[0]!, replacement);
    expect(root.querySelectorAll("form")).toHaveLength(1);
    expect(root.textContent).not.toContain("Compose beside this beat.");
    expect(root.textContent).toContain("Replacement composer.");

    const once = first.getMarkdown();
    expect(once).not.toContain("Review this beat.");
    expect(once).not.toContain("Replacement composer.");
    await first.destroy();

    const secondRoot = document.createElement("div");
    document.body.append(secondRoot);
    const second = await createManuscriptSurface({
      root: secondRoot,
      markdown: once,
      blockIds: BLOCKS,
      activation: "edit",
      accessibleName: "Chapter text for Loose Ends",
    });
    expect(second.getMarkdown()).toBe(once);
    await second.destroy();
  });

  it("exposes accessible block and tooltip foundations without serializing their UI", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let activated: string | null = null;
    const session = await createManuscriptSurface({
      root,
      markdown: SOURCE,
      blockIds: BLOCKS,
      activation: "notes",
      accessibleName: "Notes for Loose Ends",
      allowBlockNotes: true,
      onNoteActivate: (annotationId) => {
        activated = annotationId;
      },
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const handle = root.querySelector<HTMLButtonElement>(".ab-milkdown-note-handle button");
    expect(handle?.getAttribute("aria-label")).toBe("Note on this block");
    const tooltip = document.getElementById(handle?.getAttribute("aria-describedby") ?? "");
    expect(tooltip?.getAttribute("role")).toBe("tooltip");
    expect(root.querySelector('[role="region"]')?.getAttribute("aria-readonly")).toBe("true");
    session.notes.setHighlights?.([{
      annotationId: "annotation-1",
      blockId: BLOCKS[0]!,
      start: 2,
      end: 7,
      kind: "comment",
      active: true,
    }]);
    const highlight = root.querySelector<HTMLElement>("[data-authorbot-annotation-id]");
    expect(highlight?.classList.contains("ab-highlight-active")).toBe(true);
    expect(highlight?.getAttribute("role")).toBe("button");
    highlight?.click();
    expect(activated).toBe("annotation-1");
    expect(session.getMarkdown()).not.toContain("annotation-1");
    await session.destroy();
  });

  it("rejects hostile source and unsafe output before Crepe or a submit callback sees it", async () => {
    expect(validateManuscriptMarkdown("<img src=x onerror=alert(1)>")).toContain(
      "raw HTML is not allowed",
    );
    expect(validateManuscriptMarkdown("[click](javascript:alert(1))")[0]).toContain(
      "unsafe URL scheme",
    );
    expect(validateManuscriptMarkdown("<!-- authorbot:block id=bad -->\nProse")).toContain(
      "Authorbot block markers are managed by the repository writer",
    );

    const root = document.createElement("div");
    document.body.append(root);
    await expect(createManuscriptSurface({
      root,
      markdown: "<script>globalThis.pwned = true</script>",
      blockIds: [],
      activation: "edit",
      accessibleName: "Unsafe chapter",
    })).rejects.toBeInstanceOf(UnsafeManuscriptError);
    expect(root.querySelector("script")).toBeNull();
    expect((globalThis as Record<string, unknown>)["pwned"]).toBeUndefined();
  });
});
