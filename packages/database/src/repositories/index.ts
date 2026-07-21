import type { SqlDatabase } from "../sql.js";
import {
  ActorsRepository,
  AgentTokensRepository,
  HumanSessionsRepository,
  ProjectMembershipsRepository,
  ProjectsRepository,
} from "./identity.js";
import { AnnotationsRepository, ChaptersRepository, RepliesRepository } from "./content.js";
import {
  AuditEventsRepository,
  GitOperationsRepository,
  IdempotencyKeysRepository,
  OutboxRepository,
  WebhookDeliveriesRepository,
} from "./operations.js";
import {
  DecisionsRepository,
  EventsRepository,
  VoteEventsRepository,
  VotesRepository,
  WorkItemsRepository,
} from "./collaboration.js";
import { LeasesRepository, SubmissionsRepository } from "./leasing.js";
import {
  PublicationDeliveriesRepository,
  PublicationsRepository,
} from "./publications.js";
import { BookConfigsRepository } from "./settings.js";
import {
  PendingAnnotationsRepository,
  ProjectAccessControlsRepository,
  RateLimitCountersRepository,
} from "./access-control.js";

export * from "./identity.js";
export * from "./content.js";
export * from "./operations.js";
export * from "./collaboration.js";
export * from "./leasing.js";
export * from "./publications.js";
export * from "./settings.js";
export * from "./access-control.js";

/**
 * One repository per table (Phase 2 contract §2 plus the Phase 3 contract
 * §2/§4/§5 and Phase 4 contract §2/§4 tables), sharing a `SqlDatabase`.
 */
export interface Repositories {
  projects: ProjectsRepository;
  actors: ActorsRepository;
  projectMemberships: ProjectMembershipsRepository;
  humanSessions: HumanSessionsRepository;
  agentTokens: AgentTokensRepository;
  chapters: ChaptersRepository;
  annotations: AnnotationsRepository;
  replies: RepliesRepository;
  gitOperations: GitOperationsRepository;
  outbox: OutboxRepository;
  idempotencyKeys: IdempotencyKeysRepository;
  webhookDeliveries: WebhookDeliveriesRepository;
  auditEvents: AuditEventsRepository;
  votes: VotesRepository;
  voteEvents: VoteEventsRepository;
  decisions: DecisionsRepository;
  workItems: WorkItemsRepository;
  events: EventsRepository;
  leases: LeasesRepository;
  submissions: SubmissionsRepository;
  /** Phase 5 §6 / design §17.3: CI-reported publication state. */
  publications: PublicationsRepository;
  /** Phase 5 §6: dedupe ledger for signed publication callbacks. */
  publicationDeliveries: PublicationDeliveriesRepository;
  /** Phase 6 §3.6: projected `book.yml` (settings + in-book governance). */
  bookConfigs: BookConfigsRepository;
  /** Phase 7: freeze and pause-agents, the author's emergency stops. */
  projectAccessControls: ProjectAccessControlsRepository;
  /** Phase 7: the moderation queue for `approval-gated` books. */
  pendingAnnotations: PendingAnnotationsRepository;
  /** Phase 7: fixed-window mutation counters behind the 429s. */
  rateLimitCounters: RateLimitCountersRepository;
}

export function createRepositories(db: SqlDatabase): Repositories {
  return {
    projects: new ProjectsRepository(db),
    actors: new ActorsRepository(db),
    projectMemberships: new ProjectMembershipsRepository(db),
    humanSessions: new HumanSessionsRepository(db),
    agentTokens: new AgentTokensRepository(db),
    chapters: new ChaptersRepository(db),
    annotations: new AnnotationsRepository(db),
    replies: new RepliesRepository(db),
    gitOperations: new GitOperationsRepository(db),
    outbox: new OutboxRepository(db),
    idempotencyKeys: new IdempotencyKeysRepository(db),
    webhookDeliveries: new WebhookDeliveriesRepository(db),
    auditEvents: new AuditEventsRepository(db),
    votes: new VotesRepository(db),
    voteEvents: new VoteEventsRepository(db),
    decisions: new DecisionsRepository(db),
    workItems: new WorkItemsRepository(db),
    events: new EventsRepository(db),
    leases: new LeasesRepository(db),
    submissions: new SubmissionsRepository(db),
    publications: new PublicationsRepository(db),
    publicationDeliveries: new PublicationDeliveriesRepository(db),
    bookConfigs: new BookConfigsRepository(db),
    projectAccessControls: new ProjectAccessControlsRepository(db),
    pendingAnnotations: new PendingAnnotationsRepository(db),
    rateLimitCounters: new RateLimitCountersRepository(db),
  };
}
