/**
 * Publication tracking repositories (Phase 5 contract §6, design §17.3).
 *
 * The governing rule from §17.3 - "do not mark a revision published merely
 * because its Git commit succeeded" - is enforced structurally: nothing in
 * this file has a way to *derive* publication state. Every row is written from
 * a signed CI callback and nothing else, so a commit that never reached the
 * publisher can never look deployed.
 *
 * Every mutating method has a `...Statement` variant returning a bound
 * `SqlStatement` so callers can compose atomic multi-table writes with
 * `db.batch([...])` (Phase 2 contract §5 command flow) - the publication
 * upsert and its delivery-ledger row must land together or not at all.
 */
import type { SqlDatabase, SqlRow, SqlStatement } from "../sql.js";
import type {
  PublicationBuildStatus,
  PublicationDeliveryRecord,
  PublicationDeliveryStatus,
  PublicationRecord,
} from "../records.js";

/**
 * Fields a single CI callback may advance. Absent (`undefined`) means "this
 * callback said nothing about that field", which is NOT the same as `null`
 * ("CI explicitly reports no value") - a `build_status: building` callback
 * must not erase the `public_url` a previous deploy reported. The upsert below
 * distinguishes the two with COALESCE over an explicit "keep" sentinel.
 */
export interface PublicationUpsertInput {
  id: string;
  projectId: string;
  integratedCommit: string;
  buildStatus: PublicationBuildStatus;
  deployedCommit?: string | null;
  publicUrl?: string | null;
  deployedAt?: string | null;
  publisherVersion?: string | null;
  lastDeliveryId: string | null;
  at: string;
}

export class PublicationsRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Insert-or-advance the row for `(projectId, integratedCommit)`.
   *
   * On conflict, `build_status` and `updated_at` always take the new value
   * (the callback is the authority on the build it is reporting), while the
   * deployment fields are only overwritten when the callback carried them.
   * That is what lets CI send a lifecycle of small callbacks
   * (`queued` → `building` → `succeeded` → deployed) without each one having
   * to restate everything it does not know about.
   */
  upsertStatement(input: PublicationUpsertInput): SqlStatement {
    // `undefined` → bind NULL and keep the stored value via COALESCE.
    // Explicit `null` → the caller means "clear", so pass a marker the
    // COALESCE cannot swallow. SQLite has no undefined, so the distinction is
    // carried by a second bound flag per nullable field.
    const provided = (v: unknown): number => (v === undefined ? 0 : 1);
    return this.db
      .prepare(
        `INSERT INTO publications
           (id, project_id, integrated_commit, build_status, deployed_commit,
            public_url, deployed_at, publisher_version, last_delivery_id,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, integrated_commit) DO UPDATE SET
           build_status      = excluded.build_status,
           deployed_commit   = CASE WHEN ? = 1 THEN excluded.deployed_commit
                                    ELSE publications.deployed_commit END,
           public_url        = CASE WHEN ? = 1 THEN excluded.public_url
                                    ELSE publications.public_url END,
           deployed_at       = CASE WHEN ? = 1 THEN excluded.deployed_at
                                    ELSE publications.deployed_at END,
           publisher_version = CASE WHEN ? = 1 THEN excluded.publisher_version
                                    ELSE publications.publisher_version END,
           last_delivery_id  = excluded.last_delivery_id,
           updated_at        = excluded.updated_at`,
      )
      .bind(
        input.id,
        input.projectId,
        input.integratedCommit,
        input.buildStatus,
        input.deployedCommit ?? null,
        input.publicUrl ?? null,
        input.deployedAt ?? null,
        input.publisherVersion ?? null,
        input.lastDeliveryId,
        input.at,
        input.at,
        provided(input.deployedCommit),
        provided(input.publicUrl),
        provided(input.deployedAt),
        provided(input.publisherVersion),
      );
  }

  async upsert(input: PublicationUpsertInput): Promise<void> {
    await this.upsertStatement(input).run();
  }

  async getById(id: string): Promise<PublicationRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM publications WHERE id = ?`).bind(id).first();
    return row ? mapPublication(row) : null;
  }

  async getByCommit(projectId: string, integratedCommit: string): Promise<PublicationRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM publications WHERE project_id = ? AND integrated_commit = ?`)
      .bind(projectId, integratedCommit)
      .first();
    return row ? mapPublication(row) : null;
  }

  /**
   * Most recently touched publication row, or null when CI never called.
   *
   * Ordered by `updated_at`, not `created_at`: "latest" means the build CI
   * most recently said something about, and a long-running build for an older
   * commit can outlive a newer row. `id` is only a tiebreak and is NOT a
   * reliable one - UUIDv7 orders to millisecond resolution and the low bits
   * are random - so two callbacks inside the same millisecond are genuinely
   * unordered. That is acceptable here (it can only affect which of two
   * near-simultaneous *build statuses* is shown) and is precisely why the
   * deployed-commit question has its own query below rather than reading
   * `deployedCommit` off this row.
   */
  async getLatest(projectId: string): Promise<PublicationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM publications
          WHERE project_id = ?
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT 1`,
      )
      .bind(projectId)
      .first();
    return row ? mapPublication(row) : null;
  }

  /**
   * Most recent row that CI reported as actually deployed. Distinct from
   * {@link getLatest}: a newer commit sitting in `building` must not hide the
   * commit the public site is really serving (design §17.3's whole point).
   */
  async getLatestDeployed(projectId: string): Promise<PublicationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM publications
          WHERE project_id = ? AND deployed_commit IS NOT NULL
          ORDER BY COALESCE(deployed_at, created_at) DESC, id DESC
          LIMIT 1`,
      )
      .bind(projectId)
      .first();
    return row ? mapPublication(row) : null;
  }

  async listByProject(
    projectId: string,
    options: { limit?: number } = {},
  ): Promise<PublicationRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM publications
          WHERE project_id = ?
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT ?`,
      )
      .bind(projectId, options.limit ?? 50)
      .all();
    return rows.map(mapPublication);
  }
}

function mapPublication(row: SqlRow): PublicationRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    integratedCommit: String(row["integrated_commit"]),
    buildStatus: String(row["build_status"]) as PublicationBuildStatus,
    deployedCommit: nullableText(row["deployed_commit"]),
    publicUrl: nullableText(row["public_url"]),
    deployedAt: nullableText(row["deployed_at"]),
    publisherVersion: nullableText(row["publisher_version"]),
    lastDeliveryId: nullableText(row["last_delivery_id"]),
    createdAt: String(row["created_at"]),
    updatedAt: String(row["updated_at"]),
  };
}

/**
 * Delivery ledger for signed publication callbacks. Insert-first, exactly like
 * the GitHub webhook path: the UNIQUE index on `(project_id, delivery_id)` is
 * the dedupe primitive, so a replay loses the race in the database rather than
 * in a read-then-write the next isolate can interleave with.
 */
export class PublicationDeliveriesRepository {
  constructor(private readonly db: SqlDatabase) {}

  insertStatement(record: PublicationDeliveryRecord): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO publication_deliveries
           (id, project_id, delivery_id, publication_id, status, received_at, processed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.projectId,
        record.deliveryId,
        record.publicationId,
        record.status,
        record.receivedAt,
        record.processedAt,
      );
  }

  async insert(record: PublicationDeliveryRecord): Promise<void> {
    await this.insertStatement(record).run();
  }

  async getByDeliveryId(
    projectId: string,
    deliveryId: string,
  ): Promise<PublicationDeliveryRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM publication_deliveries WHERE project_id = ? AND delivery_id = ?`)
      .bind(projectId, deliveryId)
      .first();
    return row ? mapDelivery(row) : null;
  }

  setStatusStatement(
    id: string,
    status: PublicationDeliveryStatus,
    processedAt: string | null,
    publicationId?: string | null,
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE publication_deliveries
            SET status = ?,
                processed_at = ?,
                publication_id = COALESCE(?, publication_id)
          WHERE id = ?`,
      )
      .bind(status, processedAt, publicationId ?? null, id);
  }

  async setStatus(
    id: string,
    status: PublicationDeliveryStatus,
    processedAt: string | null,
    publicationId?: string | null,
  ): Promise<void> {
    await this.setStatusStatement(id, status, processedAt, publicationId).run();
  }
}

function mapDelivery(row: SqlRow): PublicationDeliveryRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    deliveryId: String(row["delivery_id"]),
    publicationId: nullableText(row["publication_id"]),
    status: String(row["status"]) as PublicationDeliveryStatus,
    receivedAt: String(row["received_at"]),
    processedAt: nullableText(row["processed_at"]),
  };
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}
