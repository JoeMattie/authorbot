/** Click-lazy coordinator for the read-only Milkdown collaboration surface. */
import "./collab-notes-mode.css";
import { createLazyManuscriptSurface } from "./manuscript-surface-loader.js";
import type { ManuscriptSurfaceSession } from "./manuscript-surface.js";

interface NotesSource {
  chapterId: string;
  title: string;
  body: string;
}

interface NotesModeDeps {
  chapterId: string;
  prose: HTMLElement;
  blockIds: readonly string[];
  current(): boolean;
  canRead(): boolean;
  canWrite(): boolean;
  prepareEditor(): Promise<boolean>;
  readSource(): Promise<
    { ok: true; value: NotesSource } | { ok: false; message: string }
  >;
  onBlockNote(blockId: string, returnFocus: HTMLElement): void;
  onNoteActivate(annotationId: string): void;
  onBlockHover(blockId: string, active: boolean): void;
  onActivated(session: ManuscriptSurfaceSession, root: HTMLElement): void;
  onDeactivated(): void;
  setBusy(busy: boolean): void;
  setStatus(message: string): void;
}

export interface CollabNotesModeController {
  readonly active: boolean;
  toggle(): Promise<void>;
  close(announce: boolean): Promise<void>;
}

export function createCollabNotesModeController(
  deps: NotesModeDeps,
): CollabNotesModeController {
  let session: ManuscriptSurfaceSession | null = null;
  let root: HTMLElement | null = null;
  let busy = false;
  let activation = 0;

  const close = async (announce: boolean): Promise<void> => {
    activation += 1;
    busy = true;
    deps.setBusy(true);
    const closing = session;
    const closingRoot = root;
    session = null;
    root = null;
    deps.onDeactivated();
    if (closing !== null) {
      try {
        await closing.destroy();
      } catch {
        // Static prose is the fail-safe even when a lazy chunk tears down badly.
      }
    }
    closingRoot?.remove();
    if (announce) deps.setStatus("Static reading view restored.");
    busy = false;
    deps.setBusy(false);
  };

  const open = async (): Promise<void> => {
    if (!deps.canRead()) return;
    const attempt = ++activation;
    busy = true;
    deps.setBusy(true);
    deps.setStatus("Loading the rich Notes view…");
    const editorReady = await deps.prepareEditor();
    if (!editorReady || !deps.current() || attempt !== activation) {
      busy = false;
      deps.setBusy(false);
      deps.setStatus(editorReady ? "" : "The chapter edit is still open.");
      return;
    }
    const read = await deps.readSource();
    if (!deps.current() || attempt !== activation) return;
    if (!read.ok || read.value.chapterId !== deps.chapterId) {
      busy = false;
      deps.setBusy(false);
      deps.setStatus(
        `The rich Notes view could not open: ${
          read.ok ? "the source response did not match this chapter" : read.message
        }.`,
      );
      return;
    }
    const mount = document.createElement("div");
    mount.className = "ab-manuscript-notes-root";
    root = mount;
    deps.prose.insertAdjacentElement("afterend", mount);
    try {
      const created = await createLazyManuscriptSurface({
        root: mount,
        markdown: read.value.body,
        blockIds: deps.blockIds,
        activation: "notes",
        accessibleName: `Notes for ${read.value.title}`,
        allowBlockNotes: deps.canWrite(),
        onBlockNote: deps.onBlockNote,
        onNoteActivate: deps.onNoteActivate,
        onBlockHover: deps.onBlockHover,
      });
      if (!deps.current() || attempt !== activation || root !== mount) {
        await created.destroy();
        mount.remove();
        return;
      }
      session = created;
      deps.onActivated(created, mount);
      deps.setStatus("Rich Notes view opened.");
      created.focus();
    } catch (caught) {
      if (root === mount) root = null;
      mount.remove();
      deps.setStatus(
        `The rich Notes view could not open: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    } finally {
      if (deps.current() && attempt === activation) {
        busy = false;
        deps.setBusy(false);
      }
    }
  };

  return {
    get active() {
      return session !== null || root !== null;
    },
    async toggle() {
      if (busy) return;
      if (session !== null || root !== null) await close(true);
      else await open();
    },
    close,
  };
}
