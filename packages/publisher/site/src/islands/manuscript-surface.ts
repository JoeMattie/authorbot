import type { ChapterNotesTargetAdapter } from "./chapter-notes-presentation.js";

/** The two explicit interactions allowed to request the heavy editor chunk. */
export type ManuscriptActivation = "notes" | "edit";

export interface ManuscriptSubmitRequest {
  markdown: string;
}

export interface ManuscriptSubmitResult {
  ok: boolean;
  message?: string;
}

export interface ManuscriptSurfaceOptions {
  /** Empty mount owned by the caller. Static prose remains outside this root. */
  root: HTMLElement;
  /** Marker- and frontmatter-free canonical chapter body. */
  markdown: string;
  /** Stable IDs in top-level manuscript block order. */
  blockIds: readonly string[];
  activation: ManuscriptActivation;
  accessibleName: string;
  allowBlockNotes?: boolean;
  onBlockNote?: (blockId: string) => void;
  onMarkdownChange?: (markdown: string) => void;
  /** Slice 4 supplies this. The editor never guesses an API route. */
  onSubmit?: (request: ManuscriptSubmitRequest) => Promise<ManuscriptSubmitResult>;
}

export interface ManuscriptSurfaceSession {
  readonly activation: ManuscriptActivation;
  readonly notes: ChapterNotesTargetAdapter;
  readonly dirty: boolean;
  getMarkdown(): string;
  focus(): void;
  submit(): Promise<ManuscriptSubmitResult>;
  destroy(): Promise<void>;
}

export interface ManuscriptSurfaceModule {
  createManuscriptSurface(
    options: ManuscriptSurfaceOptions,
  ): Promise<ManuscriptSurfaceSession>;
}
