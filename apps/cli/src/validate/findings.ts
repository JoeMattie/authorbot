/**
 * Validation finding model (Phase 0 contract section 5).
 *
 * JSON finding shape: `{ code, severity: "error"|"warning", path, message,
 * pointer? }` where `path` is repo-relative and `pointer` locates the field
 * (JSON-Pointer-style, e.g. `/nodes/2/parent`) or line (`line 16`).
 */

/** Stable validation error codes (contract section 5 table). */
export const VALIDATION_CODES = [
  "BOOK_CONFIG_MISSING",
  "BOOK_CONFIG_INVALID",
  "CHAPTER_FRONTMATTER_INVALID",
  "CHAPTER_ID_DUPLICATE",
  "CHAPTER_SLUG_DUPLICATE",
  "CHAPTER_ORDER_DUPLICATE",
  "CHAPTER_REF_UNRESOLVED",
  "BLOCK_ID_MISSING",
  "BLOCK_ID_DUPLICATE",
  "BLOCK_ID_INVALID",
  "RAW_HTML_FORBIDDEN",
  "URL_SCHEME_FORBIDDEN",
  "STORY_GRAPH_INVALID",
  "STORY_GRAPH_REF_UNRESOLVED",
  "TIMELINE_INVALID",
  "TIMELINE_REF_UNRESOLVED",
  "CHARACTER_FILE_INVALID",
  "ANNOTATION_INVALID",
  "ANNOTATION_REF_UNRESOLVED",
  "WORK_ITEM_INVALID",
  "WORK_ITEM_DELIMITER_INVALID",
  "WORK_ITEM_REF_UNRESOLVED",
  "DECISION_INVALID",
  "DECISION_REF_UNRESOLVED",
  "RELEASE_INVALID",
  "RELEASE_REF_UNRESOLVED",
  "ATTRIBUTION_INVALID",
  "PATH_UNSAFE",
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export type FindingSeverity = "error" | "warning";

export interface Finding {
  code: ValidationCode;
  severity: FindingSeverity;
  /** Repo-relative path (posix separators). */
  path: string;
  message: string;
  /** Locates the field (`/a/b/0`) or line (`line 16`). */
  pointer?: string;
}

/** Result of `validateBookRepo` and the `--json` output shape. */
export interface ValidationReport {
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
}

/** Accumulates findings during a validation run. */
export class FindingCollector {
  readonly errors: Finding[] = [];
  readonly warnings: Finding[] = [];

  error(code: ValidationCode, path: string, message: string, pointer?: string): void {
    this.push("error", code, path, message, pointer);
  }

  warning(code: ValidationCode, path: string, message: string, pointer?: string): void {
    this.push("warning", code, path, message, pointer);
  }

  add(
    severity: FindingSeverity,
    code: ValidationCode,
    path: string,
    message: string,
    pointer?: string,
  ): void {
    this.push(severity, code, path, message, pointer);
  }

  private push(
    severity: FindingSeverity,
    code: ValidationCode,
    path: string,
    message: string,
    pointer: string | undefined,
  ): void {
    const finding: Finding = { code, severity, path, message };
    if (pointer !== undefined) {
      finding.pointer = pointer;
    }
    (severity === "error" ? this.errors : this.warnings).push(finding);
  }

  report(): ValidationReport {
    return {
      valid: this.errors.length === 0,
      errors: [...this.errors],
      warnings: [...this.warnings],
    };
  }
}
