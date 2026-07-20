/**
 * Publication tracking endpoints (Phase 5 contract §6, design §17.3).
 *
 * Design §17.3 opens with the rule this module exists to enforce: *do not mark
 * a revision published merely because its Git commit succeeded*. So there is
 * deliberately no code path anywhere in the API that writes publication state
 * from its own knowledge. The only writer is `POST /v1/publications`, a signed
 * callback from CI, and the only thing the API asserts on its own behalf is
 * `projects.projected_commit` — the commit it integrated.
 *
 * The gap between those two numbers is the product: `GET /v1/projects/{id}`
 * reports integrated and deployed side by side so "the public page shows the
 * revision that was actually deployed, not the revision everyone hopes was
 * deployed" is checkable rather than assumed.
 *
 * ## Signature and replay
 *
 * The callback is unauthenticated in the session/token sense and authenticated
 * by HMAC-SHA256 with `WEBHOOK_SECRET`, compared in constant time — the same
 * primitive and the same ordering as the GitHub webhook in app.ts (verify
 * before parsing, before touching the database, before allocating anything
 * keyed on request content).
 *
 * **The signed material is `<deliveryId>.<timestamp>.<rawBody>`, not the body
 * alone.** Signing only the body left the delivery id — the sole
 * replay-suppression key — outside the signature, and nothing bound the
 * request to a point in time. Anyone who obtained one validly signed body (CI
 * logs echoing the curl invocation, a proxy log, a captured request) could
 * resubmit it forever under fresh delivery ids: the UNIQUE index never fires,
 * and each replay reaches the upsert, flipping the reported `buildStatus`
 * back and re-emitting `publication.reported` audit rows. `POST
 * /v1/publications` is by design the ONLY writer of publication state, which
 * is exactly the property design §17.3 exists to protect, so the signature
 * has to cover everything the handler acts on.
 *
 * The timestamp is rejected outside {@link PUBLICATION_MAX_SKEW_MS}, so a
 * captured request stops being replayable once it ages out even if the
 * delivery ledger is lost.
 *
 * Replays within the window are still deduped on `X-Authorbot-Delivery` via a
 * UNIQUE index, insert first. A read-then-write check would let two concurrent
 * isolates both see "not seen yet"; losing the race in the database is the
 * only version that actually holds. A repeat delivery is a no-op — unlike the
 * GitHub push handler, a *failed* publication delivery is not retried on the
 * same id, because a build status is a point-in-time report: if it mattered,
 * CI sends the next one.
 */
import type { Hono, MiddlewareHandler } from "hono";
import type { Context } from "hono";
import {
  isUniqueConstraintError,
  type ProjectRecord,
  type PublicationRecord,
  type Repositories,
} from "@authorbot/database";
import { toTimestamp } from "@authorbot/domain";
import { z } from "zod";
import { timingSafeEqual, hmacSha256Hex } from "./crypto.js";
import type { AppDeps, AppEnv, Clock } from "./deps.js";
import { uuidv7 } from "./ids.js";
import { problem } from "./problems.js";

export interface PublicationRoutesContext {
  app: Hono<AppEnv>;
  deps: AppDeps;
  repos: Repositories;
  clock: Clock;
  /** Resolves the single configured project (app.ts `getProject`). */
  getProject(): Promise<ProjectRecord | null>;
  /** `requireAuth` middleware (app.ts), applied to the read route only. */
  auth: MiddlewareHandler<AppEnv>;
  /** Project + scope guard injected by app.ts (keeps auth wiring in one place). */
  requireRead(
    c: Context<AppEnv>,
  ): Promise<{ project: ProjectRecord } | { response: Response }>;
}

/** Header carrying `sha256=<hex>` over {@link publicationSigningMaterial}. */
export const PUBLICATION_SIGNATURE_HEADER = "x-authorbot-signature-256";
/** Header carrying the unique delivery id used for replay suppression. */
export const PUBLICATION_DELIVERY_HEADER = "x-authorbot-delivery";
/** Header carrying the RFC 3339 instant the callback was signed at. */
export const PUBLICATION_TIMESTAMP_HEADER = "x-authorbot-timestamp";

/** How far a callback's signed timestamp may sit from now, either way. */
export const PUBLICATION_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * The bytes the HMAC covers: delivery id, timestamp and raw body, joined by
 * `.` — the separator is what stops a delivery id ending in digits from
 * being reinterpretable as part of the timestamp.
 */
export function publicationSigningMaterial(
  deliveryId: string,
  timestamp: string,
  rawBody: string,
): string {
  return `${deliveryId}.${timestamp}.${rawBody}`;
}

/**
 * A Git commit sha. Accepts abbreviated (≥7) through full SHA-256 (64) so the
 * table records exactly what CI reported rather than a normalization this
 * service is not entitled to make.
 */
const commitSha = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, "must be a lowercase hex commit sha");

/**
 * `http`/`https` only. A publication row is rendered into operator surfaces,
 * so a `javascript:` URL arriving from a compromised CI job must not become a
 * link (design §19.4 allow-list link protocols).
 */
const publicUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an absolute http(s) URL");

const publicationCallbackSchema = z.strictObject({
  /**
   * Optional: single-project deployments (design §22.1) can omit it. When
   * present it must match, so a callback aimed at another deployment that
   * happens to share a secret is rejected instead of silently applied here.
   */
  projectSlug: z.string().min(1).max(200).optional(),
  integratedCommit: commitSha,
  buildStatus: z.enum(["queued", "building", "succeeded", "failed"]),
  deployedCommit: commitSha.nullable().optional(),
  publicUrl: publicUrl.nullable().optional(),
  deployedAt: z.iso.datetime({ offset: true }).nullable().optional(),
  publisherVersion: z.string().min(1).max(200).nullable().optional(),
});

export type PublicationCallback = z.infer<typeof publicationCallbackSchema>;

/** Wire-shape for a publication row. */
export function publicationJson(
  publication: PublicationRecord | null,
): Record<string, unknown> | null {
  if (publication === null) {
    return null;
  }
  return {
    id: publication.id,
    integratedCommit: publication.integratedCommit,
    buildStatus: publication.buildStatus,
    deployedCommit: publication.deployedCommit,
    publicUrl: publication.publicUrl,
    deployedAt: publication.deployedAt,
    publisherVersion: publication.publisherVersion,
    createdAt: publication.createdAt,
    updatedAt: publication.updatedAt,
  };
}

/**
 * The integrated-versus-deployed view (design §17.3, §20.3).
 *
 * `integratedCommit` is what Authorbot projected — its own honest high-water
 * mark — NOT the newest publication row: CI could be several commits behind,
 * and reporting its number as "integrated" would hide exactly the gap this
 * exists to show. `inSync` is false whenever anything is unknown, because
 * "we don't know" must never render as "up to date".
 */
export function publicationStatusJson(
  project: ProjectRecord,
  latest: PublicationRecord | null,
  latestDeployed: PublicationRecord | null,
): Record<string, unknown> {
  const integratedCommit = project.projectedCommit;
  const deployedCommit = latestDeployed?.deployedCommit ?? null;
  return {
    integratedCommit,
    deployedCommit,
    buildStatus: latest?.buildStatus ?? null,
    publicUrl: latestDeployed?.publicUrl ?? null,
    deployedAt: latestDeployed?.deployedAt ?? null,
    publisherVersion: latestDeployed?.publisherVersion ?? null,
    /** True only when both commits are known AND equal. */
    inSync:
      integratedCommit !== null &&
      deployedCommit !== null &&
      integratedCommit === deployedCommit,
    latest: publicationJson(latest),
  };
}

export function registerPublicationRoutes(ctx: PublicationRoutesContext): void {
  const { app, deps, repos, clock, getProject } = ctx;
  const now = (): string => toTimestamp(clock.now());

  app.post("/v1/publications", async (c) => {
    // 1. Delivery id and timestamp are read FIRST because they are part of
    //    the signed material — but nothing is trusted until step 2 verifies
    //    the MAC over all three.
    const rawBody = await c.req.text();
    const deliveryId = c.req.header(PUBLICATION_DELIVERY_HEADER);
    if (deliveryId === undefined || deliveryId.length === 0 || deliveryId.length > 200) {
      return problem(c, "bad-request", {
        detail: `missing or oversized ${PUBLICATION_DELIVERY_HEADER} header`,
      });
    }
    const timestamp = c.req.header(PUBLICATION_TIMESTAMP_HEADER);
    if (timestamp === undefined || timestamp.length === 0 || timestamp.length > 64) {
      return problem(c, "bad-request", {
        detail: `missing or oversized ${PUBLICATION_TIMESTAMP_HEADER} header`,
      });
    }

    // 2. Signature over deliveryId + timestamp + RAW body, before any parsing.
    const signature = c.req.header(PUBLICATION_SIGNATURE_HEADER);
    if (signature === undefined || !signature.startsWith("sha256=")) {
      return problem(c, "signature-invalid", { detail: "missing publication signature" });
    }
    const expected = `sha256=${await hmacSha256Hex(
      deps.config.webhookSecret,
      publicationSigningMaterial(deliveryId, timestamp, rawBody),
    )}`;
    if (!timingSafeEqual(signature, expected)) {
      return problem(c, "signature-invalid", { detail: "invalid publication signature" });
    }

    // 3. Freshness. Only meaningful AFTER the MAC verified, because the
    //    timestamp is only trustworthy once it is known to be signed. This is
    //    the gate that expires a captured request independently of the
    //    delivery ledger.
    const signedAtMs = Date.parse(timestamp);
    if (!Number.isFinite(signedAtMs)) {
      return problem(c, "bad-request", {
        detail: `${PUBLICATION_TIMESTAMP_HEADER} must be an RFC 3339 timestamp`,
      });
    }
    if (Math.abs(clock.now().getTime() - signedAtMs) > PUBLICATION_MAX_SKEW_MS) {
      return problem(c, "signature-invalid", {
        detail: `publication callback timestamp is outside the ${String(
          PUBLICATION_MAX_SKEW_MS / 1000,
        )}s freshness window`,
      });
    }

    // 4. Body.
    let json: unknown;
    try {
      json = JSON.parse(rawBody === "" ? "null" : rawBody);
    } catch {
      return problem(c, "bad-request", { detail: "body is not valid JSON" });
    }
    const parsed = publicationCallbackSchema.safeParse(json);
    if (!parsed.success) {
      return problem(c, "validation-failed", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const callback = parsed.data;

    const project = await getProject();
    if (project === null) {
      return problem(c, "not-found", { detail: "no project configured" });
    }
    if (callback.projectSlug !== undefined && callback.projectSlug !== project.slug) {
      return problem(c, "not-found", {
        detail: "callback names a project this deployment does not serve",
      });
    }

    // 5. Dedupe: insert first, let the UNIQUE index settle races.
    const deliveryRowId = uuidv7(clock.now());
    const receivedAt = now();
    try {
      await repos.publicationDeliveries.insert({
        id: deliveryRowId,
        projectId: project.id,
        deliveryId,
        publicationId: null,
        status: "received",
        receivedAt,
        processedAt: null,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      const prior = await repos.publicationDeliveries.getByDeliveryId(project.id, deliveryId);
      return c.json({
        duplicate: true,
        applied: false,
        publicationId: prior?.publicationId ?? null,
      });
    }

    // 6. Apply. One row per integrated commit; the callback advances it.
    const existing = await repos.publications.getByCommit(project.id, callback.integratedCommit);
    const publicationId = existing?.id ?? uuidv7(clock.now());
    const at = now();
    await deps.db.batch([
      repos.publications.upsertStatement({
        id: publicationId,
        projectId: project.id,
        integratedCommit: callback.integratedCommit,
        buildStatus: callback.buildStatus,
        ...(callback.deployedCommit !== undefined
          ? { deployedCommit: callback.deployedCommit }
          : {}),
        ...(callback.publicUrl !== undefined ? { publicUrl: callback.publicUrl } : {}),
        ...(callback.deployedAt !== undefined ? { deployedAt: callback.deployedAt } : {}),
        ...(callback.publisherVersion !== undefined
          ? { publisherVersion: callback.publisherVersion }
          : {}),
        lastDeliveryId: deliveryId,
        at,
      }),
      repos.publicationDeliveries.setStatusStatement(
        deliveryRowId,
        "processed",
        at,
        publicationId,
      ),
      repos.auditEvents.insertStatement({
        id: uuidv7(clock.now()),
        projectId: project.id,
        actorId: null,
        action: "publication.reported",
        targetType: "publication",
        targetId: publicationId,
        correlationId: c.get("correlationId"),
        metadata: {
          deliveryId,
          integratedCommit: callback.integratedCommit,
          buildStatus: callback.buildStatus,
          deployedCommit: callback.deployedCommit ?? null,
        },
        createdAt: at,
      }),
      repos.events.appendStatement({
        projectId: project.id,
        type: "publication_updated",
        payload: {
          publicationId,
          integratedCommit: callback.integratedCommit,
          buildStatus: callback.buildStatus,
          deployedCommit: callback.deployedCommit ?? null,
        },
        createdAt: at,
      }),
    ]);

    const stored = await repos.publications.getById(publicationId);
    return c.json(
      { duplicate: false, applied: true, publicationId, publication: publicationJson(stored) },
      existing === undefined || existing === null ? 201 : 200,
    );
  });

  /**
   * Publication history. Read-only and membership-guarded by the caller's
   * scope check; it exposes only commit shas and build state, never CI
   * credentials or logs.
   */
  app.get("/v1/projects/:projectId/publications", ctx.auth, async (c) => {
    const guard = await ctx.requireRead(c);
    if ("response" in guard) {
      return guard.response;
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return problem(c, "validation-failed", { detail: "limit must be an integer in [1, 200]" });
    }
    const rows = await repos.publications.listByProject(guard.project.id, { limit });
    return c.json({ items: rows.map((row) => publicationJson(row)) });
  });
}
