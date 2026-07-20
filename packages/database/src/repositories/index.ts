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

export * from "./identity.js";
export * from "./content.js";
export * from "./operations.js";

/** One repository per Phase 2 contract §2 table, sharing a `SqlDatabase`. */
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
  };
}
