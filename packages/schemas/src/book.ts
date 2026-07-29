import { z } from "zod";
import { rulesMapSchema } from "./instance.js";
import { slugSchema, uuidv7Schema } from "./primitives.js";

/**
 * The four annotation policy modes (Phase 7 contract "Restricting"). Declared
 * here rather than imported from `@authorbot/domain` because `@authorbot/schemas`
 * is the leaf package every other one depends on and must not gain a dependency
 * on the domain rules; `annotation-policy.test.ts` in the domain suite pins the
 * two lists equal.
 */
export const ANNOTATION_POLICY_MODES = [
  "open",
  "approval-gated",
  "collaborators-only",
  "locked",
] as const;
export const annotationPolicySchema = z.enum(ANNOTATION_POLICY_MODES);
export type AnnotationPolicyMode = (typeof ANNOTATION_POLICY_MODES)[number];

/** One nav-href path segment: no encoding tricks, no dot-segments. */
const NAV_HREF_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Why a `publication.nav_links` href is unusable, or null when it is safe.
 * Book-relative paths only: the link lands as a live anchor on every
 * generated page, so anything scheme-ful (`javascript:`, `https:`),
 * protocol-relative (`//`), or traversing (`..`) is rejected outright.
 * Enforced inside the schema so `authorbot validate` and the publisher
 * reject identically. External URLs could be permitted later without
 * breaking any existing book.
 */
export function unsafeNavHrefReason(href: string): string | null {
  if (!href.startsWith("/")) {
    return "must be a book-relative path starting with /";
  }
  if (href.startsWith("//")) {
    return "must not be protocol-relative (//)";
  }
  if (href.includes("\\")) {
    return "must not contain backslashes";
  }
  const segments = href.split("/").slice(1);
  // A single trailing empty segment is the optional trailing slash.
  if (segments.at(-1) === "") {
    segments.pop();
  }
  if (segments.length === 0) {
    return "must name a path below the site root";
  }
  for (const segment of segments) {
    if (!NAV_HREF_SEGMENT.test(segment)) {
      return `has an unsafe path segment "${segment}"`;
    }
  }
  return null;
}

/**
 * Book config `book.yml` - `authorbot.book/v1` (design section 8.2).
 * Optional sections default at load time; the schema does not inject defaults.
 */
export const bookConfigSchema = z.strictObject({
  schema: z.literal("authorbot.book/v1"),
  id: uuidv7Schema,
  title: z.string().min(1),
  slug: slugSchema,
  /** BCP 47-style language tag, e.g. `en` or `en-US`. */
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/, "must be a language tag like en-US"),
  license: z.string().min(1).optional(),
  repository: z
    .strictObject({
      default_branch: z.string().min(1).optional(),
    })
    .optional(),
  content: z
    .strictObject({
      chapters_glob: z.string().min(1).optional(),
      raw_html: z.boolean().optional(),
    })
    .optional(),
  planning: z
    .strictObject({
      /** Method-neutral label (design section 1.2), e.g. `custom`, `snowflake`. */
      method: z.string().min(1).optional(),
      outline: z.string().min(1).optional(),
      timeline: z.string().min(1).optional(),
      characters_glob: z.string().min(1).optional(),
    })
    .optional(),
  publication: z
    .strictObject({
      /**
       * Site mode (default `generated`). `headless` skips every generated
       * page: the build emits only the book's `public/` tree, the generated
       * image thumbnails under `_astro/`, `authorbot-site.json`, and the
       * build manifest - the book owns the entire frontend, including
       * `public/index.html` for the site root. `authorbot dev` still serves
       * the generated pages either way (they are the local editorial
       * workbench, not the published site).
       */
      mode: z.enum(["generated", "headless"]).optional(),
      chapter_url: z.string().min(1).optional(),
      /**
       * Collaboration API base URL (Phase 2b contract §1); enables the
       * annotation islands at build time. `authorbot build --api-url`
       * overrides.
       */
      api_url: z.string().min(1).optional(),
      show_revision: z.boolean().optional(),
      show_attribution: z.boolean().optional(),
      show_public_annotations: z.boolean().optional(),
      /**
       * Ordered cover images for the landing-page masthead, repo-relative
       * paths under `public/` (the book-owned static directory copied
       * verbatim into the built site). The publisher generates lightweight
       * WebP thumbnails from them at build time.
       */
      cover_images: z.array(z.string().min(1)).min(1).optional(),
      /** Label for the cover thumbnail group (default "Cover art"). */
      cover_images_label: z.string().min(1).optional(),
      /**
       * Book-defined navigation links, rendered as plain anchors after the
       * built-in nav items on every generated page. Each `href` is a
       * book-relative path (typically a custom page the book ships under
       * `public/`), never an external URL. The publisher prefixes the base
       * path at build time.
       */
      nav_links: z
        .array(
          z.strictObject({
            label: z.string().min(1),
            href: z
              .string()
              .min(1)
              .superRefine((href, ctx) => {
                const reason = unsafeNavHrefReason(href);
                if (reason !== null) {
                  ctx.addIssue({ code: "custom", message: reason });
                }
              }),
          }),
        )
        .min(1)
        .optional(),
    })
    .optional(),
  /**
   * Collaboration access (Phase 7 contract "Restricting").
   *
   * `annotation_policy` is who may comment and suggest, and whether what they
   * write appears immediately: `open`, `approval-gated`, `collaborators-only`
   * (the default when the section is absent), or `locked`. It lives in
   * `book.yml` - versioned, diffable, reviewable - because it is an editorial
   * decision about the book, made deliberately and changed rarely.
   *
   * The emergency controls deliberately do NOT live here. Freeze and
   * pause-agents are operational state in the database (migration 0007
   * explains why at length): they must take effect on the next request rather
   * than the next commit, and they must work when the repository does not.
   */
  collaboration: z
    .strictObject({
      annotation_policy: annotationPolicySchema.optional(),
    })
    .optional(),
  /**
   * Governance rules (Phase 6 contract section 3.6, amending Phase 3 section
   * 3). Rules live here - versioned, diffable, and reviewable alongside the
   * prose they govern, and therefore editable from the Settings view. The
   * `RULES_JSON` environment variable remains a *bootstrap default* for a book
   * that has not set them; once `governance.rules` exists it wins outright.
   *
   * Absent and `{}` are deliberately different: absent means "not configured,
   * fall back to the environment/design default", while an explicit empty map
   * is rejected below because a book with zero rules would silently never
   * promote anything.
   */
  governance: z
    .strictObject({
      rules: rulesMapSchema
        .refine(
          (rules) => Object.keys(rules).length > 0,
          "governance.rules must define at least one rule (omit the section to use the default)",
        )
        .optional(),
    })
    .optional(),
});
export type BookConfig = z.infer<typeof bookConfigSchema>;
