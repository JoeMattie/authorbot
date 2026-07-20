export { ALLOWED, denied } from "./decision.js";
export type { Allowed, Decision, Denied } from "./decision.js";

export {
  ROLES,
  ROLE_SCOPES,
  SCOPES,
  effectiveScopes,
  requireScope,
  requireScopes,
  roleSchema,
  roleScopes,
  scopeSchema,
} from "./scopes.js";
export type { Role, Scope, ScopeDenialReason } from "./scopes.js";

export {
  ANNOTATION_STATUSES,
  ANNOTATION_TRANSITIONS,
  authorizeAnnotationWithdraw,
  canTransitionAnnotation,
  transitionAnnotation,
} from "./annotation-state.js";
export type {
  AnnotationStatus,
  AnnotationTransitionDenialReason,
  WithdrawDenialReason,
} from "./annotation-state.js";

export {
  GIT_OPERATION_STATES,
  GIT_OPERATION_TRANSITIONS,
  INITIAL_GIT_OPERATION,
  MAX_GIT_ATTEMPTS,
  canRetryGitOperation,
  canTransitionGitOperation,
  isGitOperationTerminal,
  transitionGitOperation,
} from "./git-operation-state.js";
export type {
  GitOperationDenialReason,
  GitOperationProgress,
  GitOperationState,
  GitOperationTransitionResult,
} from "./git-operation-state.js";

export {
  MAX_BODY_BYTES,
  MAX_TOKEN_NAME_LENGTH,
  bodySchema,
  normalizeBody,
  createAnnotationCommandSchema,
  createReplyCommandSchema,
  mintAgentTokenCommandSchema,
  orderedRangeTargetSchema,
  utf8ByteLength,
  withdrawAnnotationCommandSchema,
} from "./commands.js";
export type {
  CreateAnnotationCommand,
  CreateReplyCommand,
  MintAgentTokenCommand,
  MintAgentTokenCommandInput,
  WithdrawAnnotationCommand,
} from "./commands.js";

export {
  AGENT_TOKEN_PREFIX,
  AGENT_TOKEN_REGEX,
  AGENT_TOKEN_SECRET_LENGTH,
  DEFAULT_TOKEN_TTL_DAYS,
  LAST_USED_UPDATE_INTERVAL_MS,
  MAX_TOKEN_TTL_DAYS,
  SESSION_ID_LENGTH,
  SESSION_ID_REGEX,
  SESSION_TTL_DAYS,
  agentTokenSchema,
  checkTokenActive,
  isAgentTokenFormat,
  isSessionIdFormat,
  parseAgentToken,
  resolveSessionExpiry,
  resolveTokenExpiry,
  sessionIdSchema,
  shouldUpdateLastUsed,
  toTimestamp,
} from "./token.js";
export type {
  AgentTokenParseFailure,
  AgentTokenParseResult,
  TokenExpiryResult,
  TokenInactiveReason,
} from "./token.js";
