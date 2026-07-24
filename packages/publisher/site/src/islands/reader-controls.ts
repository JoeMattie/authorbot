import { html, LitElement, type TemplateResult } from "lit";

type ReaderWidth = "current" | "full";

/**
 * The first Lit pilot deliberately renders into light DOM. Reader controls
 * keep Authorbot's existing tokens and CSS while Lit owns state and markup.
 */
export class AuthorbotReaderControls extends LitElement {
  private layout: HTMLElement | null = null;
  private notesVisible = true;
  private width: ReaderWidth = "current";

  override connectedCallback(): void {
    this.layout =
      this.closest(".chapter-page")?.querySelector<HTMLElement>(".ab-reading-layout") ??
      null;
    this.classList.add("ab-reader-controls");
    super.connectedCallback();
    this.apply(false);
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override render(): TemplateResult {
    const notesLabel = this.notesVisible ? "Hide notes" : "Show notes";
    const widthLabel = this.width === "current" ? "Full width" : "Reading width";
    return html`
      <button
        class="ab-reader-control"
        type="button"
        aria-label=${notesLabel}
        title=${notesLabel}
        aria-pressed=${String(!this.notesVisible)}
        @click=${this.toggleNotes}
      >
        <span
          class="ab-reader-control-glyph ab-reader-control-panel-glyph"
          aria-hidden="true"
        ></span>
      </button>
      <button
        class="ab-reader-control"
        type="button"
        aria-label=${widthLabel}
        title=${widthLabel}
        aria-pressed=${String(this.width === "full")}
        ?hidden=${this.notesVisible}
        @click=${this.toggleWidth}
      >
        <span
          class="ab-reader-control-glyph ab-reader-control-full-glyph"
          aria-hidden="true"
        ></span>
      </button>
    `;
  }

  private readonly toggleNotes = (): void => {
    this.notesVisible = !this.notesVisible;
    if (this.notesVisible) this.width = "current";
    this.apply(true);
    this.requestUpdate();
  };

  private readonly toggleWidth = (): void => {
    this.width = this.width === "current" ? "full" : "current";
    this.apply(true);
    this.requestUpdate();
  };

  private apply(announce: boolean): void {
    const layout = this.layout;
    if (layout === null) return;
    if (this.notesVisible) this.width = "current";
    layout.dataset.notesVisibility = this.notesVisible ? "shown" : "hidden";
    layout.dataset.readerWidth = this.width;
    layout.dispatchEvent(
      new CustomEvent("authorbot-notes-visibility-change", {
        bubbles: true,
        detail: { visible: this.notesVisible },
      }),
    );
    if (!announce) return;
    this.dispatchEvent(
      new CustomEvent("authorbot-reader-layout-change", {
        bubbles: true,
        detail: {
          label: this.notesVisible ? "Notes shown" : "Notes hidden",
          notesVisible: this.notesVisible,
          width: this.width,
        },
      }),
    );
  }
}
