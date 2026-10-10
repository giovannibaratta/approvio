# A1 source inventory

Generated from checked-out source by `node docs/adr-010-tasks/inventory.mjs`. This is evidence, not a replacement for the decisions in contracts.md.

## approvio

Branch: `main`. HEAD: `8ca9dc7a47aba37ab23aad1e8787338a06b293d3`.

```text
?? docs/ADR/reviews/experiments/
?? docs/adr-009-tasks/
?? docs/adr-010-tasks/
?? native-evaluators-requirements.md
```

Package: @approvio/backend@0.0.1; API: 0.0.58; SDK: none.

## approvio-api

Branch: `main`. HEAD: `7502198ec856329cf63c43e18c8316706e84610e`.

```text
(clean)
```

Package: @approvio/api@0.0.58; API: none; SDK: none.

## approvio-ts-sdk

Branch: `main`. HEAD: `1da5e79a627c1f489d3c03fc4700aeed8b2f57b4`.

```text
(clean)
```

Package: @approvio/ts-sdk@0.0.28; API: 0.0.58; SDK: none.

## approvio-frontend

Branch: `main`. HEAD: `cfb4eea123773d6025dd2d05c8451ff101f345ca`.

```text
(clean)
```

Package: @approvio/frontend@0.0.1; API: 0.0.57; SDK: 0.0.27.

## approvio-cli

Branch: `main`. HEAD: `6be8bb459c89c96d835d2a267864d93d1bd3f966`.

```text
M  package.json
M  src/commands/agent-role/assign-agent-roles.ts
M  src/commands/agent-role/remove-agent-roles.ts
M  src/commands/agent/create-agent.ts
M  src/commands/auth/login.ts
M  src/commands/group-member/list-group-members.ts
M  src/commands/user-role/assign-user-roles.ts
M  src/commands/user-role/remove-user-roles.ts
M  src/commands/workflow-template/create-workflow-template.ts
M  src/commands/workflow/vote-workflow.ts
A  src/utils/local-oauth-server.ts
M  src/utils/parse-roles.ts
M  src/utils/sdk.ts
A  test-template.yaml
M  yarn.lock
```

Package: @approvio/cli@0.0.1; API: 0.0.54; SDK: 0.0.23.

## Backend drift from 37f38f3

```text
(no file-content changes)
```

## API imports: every declaration

- `app/controllers/test/organization-usage.e2e.test.ts`: `import { OrganizationEntitlementsResponse, OrganizationUsageResponse, validateOrganizationEntitlementsResponse, validateOrganizationUsageResponse } from "@approvio/api"`
- `app/controllers/src/resources/resources.controller.ts`: `import {ResourceResolveResponse as ApiResourceResolveResponse, validateResourceResolveRequest} from "@approvio/api"`
- `app/external/src/database/workflow-template.repository.ts`: `import {SortBy, SortDirection} from "@approvio/api"`
- `app/controllers/src/resources/resources.mappers.ts`: `import {ResourceResolveResponse as ApiResourceResolveResponse, validateResourceResolveRequest} from "@approvio/api"`
- `app/controllers/src/organizations/organization.controller.ts`: `import {OrganizationEntitlementsResponse, OrganizationUsageResponse} from "@approvio/api"`
- `app/controllers/src/organizations/organization.mappers.ts`: `import { MetricUsageItem, OrganizationEntitlementsResponse, OrganizationUsageResponse, validateOrganizationEntitlementsResponse, validateOrganizationUsageResponse } from "@approvio/api"`
- `app/controllers/src/organization-admin/organization-admin.mappers.ts`: `import { OrganizationAdmin as OrganizationAdminApi, OrganizationAdminCreate, OrganizationAdminRemove, Pagination as PaginationApi } from "@approvio/api"`
- `app/controllers/src/organization-admin/organization-admin.controller.ts`: `import { OrganizationAdmin as OrganizationAdminApi, OrganizationAdminCreate, OrganizationAdminRemove, Pagination as PaginationApi } from "@approvio/api"`
- `app/controllers/src/shared/mappers.ts`: `import {ApprovalRule as ApprovalRuleApi} from "@approvio/api"`
- `app/controllers/src/audit-logs/audit-logs.controller.ts`: `import {validateListAuditLogsParams, validateListMyAuditLogsParams} from "@approvio/api"`
- `app/controllers/src/audit-logs/audit-logs.mappers.ts`: `import { ListAuditLogsParamsValidationError, ListMyAuditLogsParamsValidationError, ListAuditLogsParams, ListMyAuditLogsParams } from "@approvio/api"`
- `app/controllers/src/agents/agents.mappers.ts`: `import { AgentRegistrationRequest, AgentRegistrationResponse, AgentGet200Response, RoleOperationRequestValidationError } from "@approvio/api"`
- `app/controllers/src/agents/agents.controller.ts`: `import { AgentRegistrationRequest, AgentRegistrationResponse, RoleAssignmentRequest, RoleRemovalRequest, AgentGet200Response, validateRoleAssignmentRequest, validateRoleRemovalRequest } from "@approvio/api"`
- `app/main/test/integration/resources/resources.integration.test.ts`: `import {ResourceResolveResponse} from "@approvio/api"`
- `app/controllers/src/spaces/spaces.controller.ts`: `import {Space as SpaceApi, SpaceCreate, ListSpaces200Response, validateListSpacesParams} from "@approvio/api"`
- `app/controllers/src/workflows/workflows.controller.ts`: `import { validateListWorkflowsParams, Workflow as WorkflowApi, CanVoteResponse as CanVoteResponseApi, ListWorkflows200Response, GetWorkflowVotes200Response } from "@approvio/api"`
- `app/controllers/src/workflows/workflows.mappers.ts`: `import { WorkflowCreate as WorkflowCreateApi, ListWorkflows200Response, WorkflowVoteRequest as WorkflowVoteRequestApi, CanVoteResponse as CanVoteResponseApi, Workflow as WorkflowApi, GetWorkflowParams, GetWorkflowVotes200Response, WorkflowVote, validateListWorkflowsParams, ListWorkflowsParams } from "@approvio/api"`
- `app/controllers/src/users/users.mappers.ts`: `import {ListUsers200Response, User as UserApi, UserCreate, RoleOperationRequestValidationError} from "@approvio/api"`
- `app/controllers/src/users/users.controller.ts`: `import { Pagination as PaginationApi, User as UserApi, UserCreate, UserSummary as UserSummaryApi, RoleAssignmentRequest, RoleRemovalRequest, validateRoleAssignmentRequest, validateRoleRemovalRequest } from "@approvio/api"`
- `app/controllers/src/spaces/spaces.mappers.ts`: `import {Space as SpaceApi, SpaceCreate, ListSpaces200Response} from "@approvio/api"`
- `app/main/test/integration/auth/agent-auth.integration.test.ts`: `import {AgentChallengeRequest, AgentTokenRequest} from "@approvio/api"`
- `app/controllers/src/roles/roles.mappers.ts`: `import {RoleTemplate as RoleTemplateApi} from "@approvio/api"`
- `app/controllers/src/roles/roles.controller.ts`: `import {ListRoleTemplates200Response} from "@approvio/api"`
- `app/controllers/src/workflow-templates/workflow-templates.controller.ts`: `import { WorkflowTemplateCreate, WorkflowTemplate as WorkflowTemplateApi, ListWorkflowTemplates200Response, WorkflowTemplateUpdate, WorkflowTemplateDeprecate, validateListWorkflowTemplatesParams } from "@approvio/api"`
- `app/controllers/src/workflow-templates/workflow-templates.mappers.ts`: `import { WorkflowTemplateCreate as WorkflowTemplateCreateApi, WorkflowTemplateUpdate as WorkflowTemplateUpdateApi, WorkflowAction as WorkflowActionApi, WorkflowTemplate as WorkflowTemplateApi, WorkflowTemplateSummary as WorkflowTemplateSummaryApi, ApprovalRule as ApprovalRuleApi, ListWorkflowTemplates200Response, validateListWorkflowTemplatesParams, ListWorkflowTemplatesParams, SortBy, SortDirection } from "@approvio/api"`
- `app/controllers/src/groups/groups.controller.ts`: `import { AddGroupEntitiesRequest, Group as GroupApi, GroupCreate, ListGroupEntities200Response, ListGroups200Response, RemoveGroupEntitiesRequest, validateListGroupsParams } from "@approvio/api"`
- `app/controllers/src/groups/groups.mappers.ts`: `import {Group as GroupApi, GroupCreate, ListGroupEntities200Response, ListGroups200Response} from "@approvio/api"`
- `app/controllers/src/internal/health/health.mapper.ts`: `import {HealthResponse} from "@approvio/api"`
- `app/controllers/src/internal/health/health.controller.ts`: `import {HealthResponse} from "@approvio/api"`
- `app/controllers/src/auth/auth.validators.ts`: `import {RefreshTokenRequest, TokenRequest, PrivilegedTokenExchangeRequest} from "@approvio/api"`
- `app/controllers/src/auth/web-auth.validators.ts`: `import {OidcCallbackRequest, PrivilegedTokenExchangeRequest} from "@approvio/api"`
- `app/controllers/src/auth/agent-auth.mappers.ts`: `import {AgentChallengeRequest, AgentChallengeResponse, AgentTokenRequest, AgentTokenResponse} from "@approvio/api"`
- `app/controllers/src/auth/cli-auth.controller.ts`: `import {TokenResponse, PrivilegedTokenResponse} from "@approvio/api"`
- `app/main/test/integration/quotas/quotas.integration.test.ts`: `import {QuotaCreate, QuotaUpdate} from "@approvio/api"`
- `app/controllers/src/auth/auth-providers.controller.ts`: `import {AuthProvider} from "@approvio/api"`
- `app/controllers/src/auth/auth.controller.ts`: `import { TokenResponse, AgentChallengeRequest, AgentChallengeResponse, AgentTokenResponse, RefreshTokenRequest, AgentTokenRequest, GetEntityInfo200Response } from "@approvio/api"`
- `app/controllers/src/auth/cli-auth.validators.ts`: `import {TokenRequest, RefreshTokenRequest, PrivilegedTokenExchangeRequest} from "@approvio/api"`
- `app/controllers/src/auth/auth.mappers.ts`: `import {GetEntityInfo200Response, TokenResponse, PrivilegedTokenExchangeRequest} from "@approvio/api"`
- `app/main/test/integration/health/health.integration.test.ts`: `import {HealthResponse} from "@approvio/api"`
- `app/main/test/integration/organization-admin/organization-admin.integration.test.ts`: `import { OrganizationAdminCreate, OrganizationAdminRemove, OrganizationAdmin as OrganizationAdminApi, Pagination as PaginationApi } from "@approvio/api"`
- `app/main/test/integration/users/users.integration.test.ts`: `import {UserCreate} from "@approvio/api"`
- `app/main/test/integration/users/users.integration.test.ts`: `import {UserSummary} from "@approvio/api"`
- `app/main/test/integration/users/user-roles.integration.test.ts`: `import {RoleAssignmentRequest} from "@approvio/api"`
- `app/main/test/integration/agents/agent-roles.integration.test.ts`: `import {RoleAssignmentRequest, RoleRemovalRequest} from "@approvio/api"`
- `app/main/test/integration/agents/agents.integration.test.ts`: `import {AgentRegistrationRequest} from "@approvio/api"`
- `app/main/test/integration/spaces/spaces.integration.test.ts`: `import {SpaceCreate, ListSpaces200Response, Space as SpaceApi} from "@approvio/api"`
- `app/main/test/integration/workflows/workflow-templates.integration.test.ts`: `import { WorkflowTemplateCreate, WorkflowTemplateUpdate, WorkflowTemplate as WorkflowTemplateApi, ListWorkflowTemplates200Response } from "@approvio/api"`
- `app/main/test/integration/workflows/workflows.integration.test.ts`: `import { CanVoteResponse as CanVoteResponseApi, Workflow as WorkflowApi, WorkflowCreate, WorkflowVoteRequest as WorkflowVoteRequestApi, ListWorkflows200Response, GetWorkflowVotes200Response } from "@approvio/api"`
- `app/main/test/integration/workflows/agent-workflows-voting.integration.test.ts`: `import {CanVoteResponse as CanVoteResponseApi, WorkflowVoteRequest as WorkflowVoteRequestApi} from "@approvio/api"`
- `app/controllers/src/quotas/quotas.mappers.ts`: `import {ListQuotasParamsValidationError, QuotaCreate, QuotaValidationError} from "@approvio/api"`
- `app/controllers/src/quotas/quotas.controller.ts`: `import { QuotaUpdate, validateListQuotasParams, validateQuotaUpdate, validateQuotaCreate, ListQuotasParams } from "@approvio/api"`
- `app/services/src/workflow-template/interfaces.ts`: `import {SortBy, SortDirection} from "@approvio/api"`
- `app/main/test/integration/groups/groups-membership-agents.integration.test.ts`: `import {AddGroupEntitiesRequest, ListGroupEntities200Response, RemoveGroupEntitiesRequest} from "@approvio/api"`
- `app/main/test/integration/groups/groups.integration.test.ts`: `import { AddGroupEntitiesRequest, GroupCreate, ListGroupEntities200Response, ListGroups200Response, RemoveGroupEntitiesRequest, Group as GroupApi, validateListGroups200Response } from "@approvio/api"`
- `app/services/src/auth/auth.service.ts`: `import {AuthProvider} from "@approvio/api"`

## Existing service contracts

Exact declarations below are the baseline for the context-first transformation specified in contracts.md. Preserve overloads/generics and existing request/result types unless the explicit replacement list applies.

### app/services/src/transaction/interfaces.ts

```typescript
export interface TransactionManager {
  execute<T, E extends string>(
    computation: () => TaskEither<E, T>,
    options?: TransactionOptions
  ): TaskEither<E | ExecutionError, T>
}
```

### app/services/src/queue/interface.ts

```typescript
export interface QueueProvider {
  enqueueWorkflowStatusRecalculation(workflowId: string): TaskEither<EnqueueRecalculationError, void>
  enqueueWorkflowStatusRecalculationBulk(workflowIds: string[]): TaskEither<EnqueueRecalculationError, void>
  enqueueWorkflowStatusChanged(event: WorkflowStatusChangedEvent): TaskEither<EnqueueWorkflowStatusChangedError, void>
  enqueueWorkflowAction(
    event: WorkflowActionEmailEvent | WorkflowActionWebhookEvent | WorkflowActionSlackEvent
  ): TaskEither<EnqueueWorkflowActionError, void>
  checkHealth(): TaskEither<QueueHealthCheckFailed, void>
}
```

### app/services/src/space/interfaces.ts

```typescript
export interface SpaceRepository {
  createSpaceWithUserPermissions(data: CreateSpaceWithUserPermissionsRepo): TaskEither<CreateSpaceRepoError, Space>
  getSpaceById(data: GetSpaceByIdRepo): TaskEither<GetSpaceRepoError, Versioned<Space>>
  getSpaceByName(data: GetSpaceByNameRepo): TaskEither<GetSpaceRepoError, Versioned<Space>>
  getSpacesByIds(spaceIds: string[]): TaskEither<UnknownError, {id: string; name: string}[]>
  listSpaces(data: ListSpacesRepo): TaskEither<ListSpacesRepoError, ListSpacesResult>
  deleteSpace(data: DeleteSpaceRepo): TaskEither<DeleteSpaceRepoError, void>
  countSpaces(): TaskEither<UnknownError, number>
}
export interface CreateSpaceWithUserPermissionsRepo {
  space: Space
  user: User
  userOcc: bigint
}
export interface GetSpaceByIdRepo {
  spaceId: string
}
export interface GetSpaceByNameRepo {
  spaceName: string
}
export interface ListSpacesRepo {
  page: number
  limit: number
  search?: string
}
export interface DeleteSpaceRepo {
  spaceId: string
}
export interface ListSpacesResult {
  spaces: ReadonlyArray<Versioned<Space>>
  total: number
  page: number
  limit: number
}
export interface CreateSpaceRequest extends RequestorAwareRequest {
  spaceData: Omit<Space, "id" | "createdAt" | "updatedAt">
}
export interface GetSpaceRequest extends RequestorAwareRequest {
  spaceId: string
}
export interface ListSpacesRequest extends RequestorAwareRequest {
  page?: number
  limit?: number
  search?: string
}
export interface DeleteSpaceRequest extends RequestorAwareRequest {
  spaceId: string
}
```

### app/services/src/task/interfaces.ts

```typescript
export interface TaskUpdateChecks {
  occ: bigint
  lockOwner: string
}
export interface TaskReference {
  type: WorkflowActionType
  taskId: string
}
export interface TaskRepository {
  createEmailTask(task: DecoratedWorkflowActionEmailTask<{occ: true}>): TaskEither<TaskCreateError, void>
  updateEmailTask(task: WorkflowActionEmailTask, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, Occ>
  createWebhookTask(task: DecoratedWorkflowActionWebhookPendingTask<{occ: true}>): TaskEither<TaskCreateError, void>
  updateWebhookTask<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionWebhookTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>
  lockTask(taskReference: TaskReference, lockOwner: string): TaskEither<TaskLockError, Occ>
  releaseLock(taskReference: TaskReference, checks: TaskUpdateChecks): TaskEither<TaskUpdateError, void>
  getWebhookTask(taskId: string): TaskEither<TaskGetErrorWebhookTask, DecoratedWorkflowActionWebhookTask<{occ: true}>>
  getEmailTask(taskId: string): TaskEither<TaskGetErrorEmailTask, DecoratedWorkflowActionEmailTask<{occ: true}>>
  createSlackTask(task: DecoratedWorkflowActionSlackPendingTask<{occ: true}>): TaskEither<TaskCreateError, void>
  updateSlackTask<T extends WorkflowActionTaskDecoratorSelector>(
    task: DecoratedWorkflowActionSlackTask<T>,
    checks: TaskUpdateChecks
  ): TaskEither<TaskUpdateError, Occ>
  getSlackTask(taskId: string): TaskEither<TaskGetErrorSlackTask, DecoratedWorkflowActionSlackTask<{occ: true}>>
}
```

### app/services/src/workflow-template/interfaces.ts

```typescript
export interface WorkflowTemplateRepository {
  createWorkflowTemplate(
    data: WorkflowTemplate
  ): TaskEither<CreateWorkflowTemplateRepoError | WorkflowTemplateValidationError, Versioned<WorkflowTemplate>>
  getParentSpace(templateId: string): TaskEither<WorkflowTemplateGetParentSpaceError, string>
  getWorkflowTemplateById(templateId: string): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>>
  getWorkflowTemplateByNameAndVersion(
    templateName: string,
    version: number
  ): TaskEither<WorkflowTemplateGetError, Versioned<WorkflowTemplate>>
  getActiveWorkflowTemplateByName(
    templateName: string
  ): TaskEither<WorkflowTemplateGetActiveError, Versioned<WorkflowTemplate>>
  getMostRecentNonActiveWorkflowTemplateByName(
    templateName: string
  ): TaskEither<WorkflowTemplateGetError, Option<Versioned<WorkflowTemplate>>>
  updateWorkflowTemplate(
    template: Versioned<WorkflowTemplate>
  ): TaskEither<WorkflowTemplateUpdateError, Versioned<WorkflowTemplate>>
  listWorkflowTemplates(
    request: ListWorkflowTemplatesRequestRepo
  ): TaskEither<WorkflowTemplateValidationError | UnknownError, ListWorkflowTemplatesResponse>
  atomicUpdateAndCreate(data: {
    existingTemplate: Versioned<WorkflowTemplate>
    newTemplate: WorkflowTemplate
  }): TaskEither<WorkflowTemplateUpdateError | CreateWorkflowTemplateRepoError, Versioned<WorkflowTemplate>>
  getWorkflowTemplatesParentsByNames(
    templateNames: ReadonlyArray<string>
  ): TaskEither<"workflow_template_not_found", ReadonlyMap<string, string>>
  countUniqueWorkflowTemplatesBySpaceId(spaceId: string): TaskEither<UnknownError, number>
}
export interface Sort {
  readonly field: SortBy
  readonly direction: SortDirection
}
interface ListWorkflowTemplateRequestNoFilters {
  search?: string
  searchMode?: "CONTAINS" | "EXACT"
  pagination: {
    page: number
    limit: number
  }
  sort?: readonly Sort[]
}
export interface ListWorkflowTemplatesRequest extends RequestorAwareRequest, ListWorkflowTemplateRequestNoFilters {
  filters?: {
    spaceIdentifier?: string
    status?: readonly [WorkflowTemplateStatus, ...WorkflowTemplateStatus[]]
  }
}
export interface ListWorkflowTemplatesRequestRepo extends ListWorkflowTemplateRequestNoFilters {
  filters?: {
    spaceId?: string
    spaceName?: string
    status?: readonly [WorkflowTemplateStatus, ...WorkflowTemplateStatus[]]
  }
}
export interface ListWorkflowTemplatesResponse {
  templates: ReadonlyArray<WorkflowTemplateSummary>
  pagination: {
    total: number
    page: number
    limit: number
  }
}
export interface CreateWorkflowTemplateRequest extends RequestorAwareRequest {
  workflowTemplateData: {
    name: string
    description?: string
    approvalRule: ApprovalRule
    actions?: ReadonlyArray<unknown>
    defaultExpiresInHours?: number
    spaceId: string
  }
}
export interface UpdateWorkflowTemplateRequest extends RequestorAwareRequest {
  templateName: string
  occVersion: bigint
  workflowTemplateData: Partial<CreateWorkflowTemplateRequest["workflowTemplateData"]>
  cancelWorkflows?: boolean
}
export interface DeprecateWorkflowTemplateRequest extends RequestorAwareRequest {
  templateName: string
  cancelWorkflows?: boolean
}
export interface CreateWorkflowTemplateRepo {
  workflowTemplate: WorkflowTemplate
}
```

### app/services/src/resources/interfaces.ts

```typescript
export interface ResourceResolveRequestItem {
  type: ResolveResourceType
  id: string
}
export interface ResourceResolveRequest {
  resources: ResourceResolveRequestItem[]
}
export interface ResourceResolvedItem {
  type: ResolveResourceType
  id: string
  name: string
}
export interface ResolveResourcesRequest {
  requestor: AuthenticatedEntity
  request: ResourceResolveRequest
}
export interface ResourceDeniedItem {
  type: ResolveResourceType
  id: string
  reason: "NOT_FOUND" | "NOT_AUTHORIZED"
}
export interface ResourceResolveResponse {
  resolved: ResourceResolvedItem[]
  denied: ResourceDeniedItem[]
}
```

### app/services/src/usage-metering/interfaces.ts

```typescript
export interface ReservationResult {
  readonly allowed: boolean
  readonly consumed: number
  readonly reserved: number
}
export interface QuotaAdmissionClient {
  reserve(
    key: string,
    limit: number,
    estimate: number,
    ttlSeconds?: number
  ): TE.TaskEither<QuotaAdmissionError, ReservationResult>
  settle(key: string, estimate: number, actual: number): TE.TaskEither<QuotaAdmissionError, number>
  release(key: string, estimate: number): TE.TaskEither<QuotaAdmissionError, void>
  getUsage(key: string): TE.TaskEither<QuotaAdmissionError, {consumed: number; reserved: number}>
}
export interface ActorUsageSummary {
  readonly actor: Actor
  readonly totalQuantity: bigint
}
export interface UsageEventRepository {
  persist(event: CreateUsageEvent): TE.TaskEither<UnknownError, void>
  persistBatch(events: CreateUsageEvent[]): TE.TaskEither<UnknownError, void>
  getPeriodTotal(metric: UsageMetric, fromDate: Date, toDate: Date): TE.TaskEither<UnknownError, bigint>
  getActorBreakdown(metric: UsageMetric, fromDate: Date, toDate: Date): TE.TaskEither<UnknownError, ActorUsageSummary[]>
}
export interface AdmitAndReserveParams {
  readonly orgId: string
  readonly entity: UsageEntity
  readonly actor: Actor
  readonly metric: UsageMetric
  readonly estimatedUnits: number
  readonly period: string
  readonly isBillable?: boolean
}
export interface SettleUsageParams {
  readonly orgId: string
  readonly entity: UsageEntity
  readonly actor: Actor
  readonly metric: UsageMetric
  readonly estimatedUnits: number
  readonly actualUnits: number
  readonly period: string
  readonly isBillable?: boolean
  readonly metadata?: Record<string, unknown>
}
export interface CancelReservationParams {
  readonly orgId: string
  readonly metric: UsageMetric
  readonly estimatedUnits: number
  readonly period: string
}
export interface MetricUsageSummary {
  readonly metric: UsageMetric
  readonly limit: TierQuotaLimit
  readonly consumed: number
  readonly reserved: number
  readonly remaining: TierQuotaLimit
  readonly unit: MetricUnit
}
export interface OrganizationUsageSummary {
  readonly orgId: string
  readonly period: string
  readonly periodStartsAt: Date
  readonly periodEndsAt: Date
  readonly metrics: MetricUsageSummary[]
}
```

### app/services/src/auth/interfaces.ts

```typescript
export interface PkceChallenge {
  codeChallenge: string
  codeVerifier: string
  state: string
}
export interface PkceData {
  codeVerifier: string
  redirectUri: string
  oidcState: string
  providerId: string
}
export interface PkceStorageData extends PkceData {
  expiresAt: Date
}
export interface PkceSessionData extends PkceStorageData {
  state: string
  occ: bigint
  usedAt?: Date
}
export interface PkceSessionRepository {
  storePkceData(state: string, data: PkceStorageData): TaskEither<PkceError, void>
  retrievePkceData(state: string): TaskEither<PkceError, PkceSessionData>
  deletePkceData(state: string): TaskEither<PkceError, void>
  updatePkceSession(sessionData: PkceSessionData, occCheck: bigint): TaskEither<PkceError, void>
}
export interface OidcTokenResponse {
  accessToken: string
  tokenType: string
  expiresIn?: number
  refreshToken?: string
  scope?: string
  idToken?: string
}
export interface OidcUserInfo {
  readonly sub: string
  readonly name?: string
  readonly email?: string
  readonly emailVerified?: boolean
  readonly preferredUsername?: string
  readonly givenName?: string
  readonly familyName?: string
}
export interface OidcTokenRequest {
  grantType: "authorization_code"
  code: string
  redirectUri: string
  codeVerifier: string
  providerId: string
}
export interface OidcProvider {
  exchangeCodeForTokens(request: OidcTokenRequest): TaskEither<OidcError, OidcTokenResponse>
  getUserInfo(accessToken: string, expectedSubject: string, providerId: string): TaskEither<OidcError, OidcUserInfo>
  getAuthorizationUrl(
    pkce: PkceChallenge,
    assuranceLevel: AssuranceLevel,
    redirectUri: string,
    providerId: string
  ): Either<OidcError, string>
  verifyAssuranceLevel(idToken: string, assuranceLevel: AssuranceLevel, providerId: string): Either<OidcError, void>
}
export interface AgentChallengeRepository {
  persistChallenge(challenge: AgentChallenge): TaskEither<AgentChallengeCreateError, AgentChallenge>
  getChallengeByNonce(nonce: string): TaskEither<GetChallengeByNonceError, DecoratedAgentChallenge<{occ: true}>>
  updateChallenge(challenge: DecoratedAgentChallenge<{occ: true}>): TaskEither<AgentChallengeUpdateError, void>
}
export interface RefreshTokenRepository {
  createToken(token: RefreshToken): TaskEither<RefreshTokenCreateError, RefreshToken>
  getByTokenHash(tokenHash: string): TaskEither<RefreshTokenGetError, DecoratedRefreshToken<{occ: true}>>
  persistNewTokenUpdateOldForUser(
    newTokenToPersist: DecoratedActiveUserRefreshToken<{occ: true}>,
    oldTokenToUpdate: UsedUserRefreshToken,
    occCheckOldToken: bigint
  ): TaskEither<RefreshTokenUpdateError, void>
  persistNewTokenUpdateOldForAgent(
    newTokenToPersist: DecoratedActiveAgentRefreshToken<{occ: true}>,
    oldTokenToUpdate: UsedAgentRefreshToken,
    occCheckOldToken: bigint
  ): TaskEither<RefreshTokenUpdateError, void>
  revokeFamily(familyId: string): TaskEither<RefreshTokenUpdateError, void>
}
export interface TokenPair {
  accessToken: string
  refreshToken: string
  accessTokenExpiresInSec: number
  refreshTokenExpiresInSec: number
}
export interface PrivilegedToken {
  token: string
  expiresInSec: number
}
export interface StepUpTokenRepository {
  storeToken(jti: string, ttlSeconds: number): TaskEither<StoreTokenError, void>
  consumeToken(jti: string): TaskEither<ConsumeTokenError, void>
}
export interface PrivilegeTokenExchange {
  readonly code: string
  readonly state: string
  readonly operation: StepUpOperation
  readonly resourceId?: string
}
export interface DpopTokenRepository {
  markJtiAsUsed(jti: string, ttlSeconds: number): TaskEither<UnknownError | "dpop_jti_reused", void>
}
```

### app/services/src/webhook/interfaces.ts

```typescript
export interface HttpClientOptions {
  idempotencyKey?: string
  isIdempotent?: boolean
}
export interface HttpClient {
  execute(
    url: string,
    method: string,
    headers?: Record<string, string>,
    payload?: unknown,
    options?: HttpClientOptions
  ): TaskEither<HttpError, HttpResponse>
}
```

### app/services/src/lever/lever.interface.ts

```typescript
export interface LeverProvider {
  isLeverActive(
    leverName: LeverName,
    defaultValue: boolean,
    context?: EvaluationContext
  ): TaskEither<LeverError, boolean>
}
```

### app/services/src/organization-admin/interfaces.ts

```typescript
export interface PaginatedOrganizationAdminsList {
  readonly admins: ReadonlyArray<OrganizationAdmin>
  readonly page: number
  readonly limit: number
  readonly total: number
}
export interface OrganizationAdminRepository {
  createOrganizationAdmin(admin: OrganizationAdmin): TaskEither<OrganizationAdminCreateError, OrganizationAdmin>
  listOrganizationAdmins(
    params: ListOrganizationAdminsRepoRequest
  ): TaskEither<OrganizationAdminListError, PaginatedOrganizationAdminsList>
  removeOrganizationAdminIfNotLast(userId: string): TaskEither<OrganizationAdminRemoveError, void>
  removeOrganizationAdminByEmailIfNotLast(email: string): TaskEither<OrganizationAdminRemoveError, void>
}
export interface ListOrganizationAdminsRepoRequest {
  readonly page: number
  readonly limit: number
}
```

### app/services/src/rate-limiter/rate-limiter.interface.ts

```typescript
export interface RateLimiterProvider {
  consume(key: string, points: number): TE.TaskEither<ConsumePointsError, RateLimiterRes>
}
```

### app/services/src/vote/interfaces.ts

```typescript
export interface VoteRepository {
  persistVoteAndMarkWorkflowRecalculation(vote: Vote): TaskEither<PersistVoteError, Vote>
  getOptionalLatestVoteByWorkflowAndVoter(
    workflowId: string,
    voter: EntityReference
  ): TaskEither<GetLatestVoteError, Option<Vote>>
  getVotesByWorkflowId(workflowId: string): TaskEither<FindVotesError, ReadonlyArray<Vote>>
}
```

### app/services/src/user-identity/interfaces.ts

```typescript
export interface UserIdentity {
  id: string
  userId: string
  providerId: string
  subjectId: string
  email: string
  createdAt: Date
}
export interface UserIdentityCreate {
  userId: string
  providerId: string
  subjectId: string
  email: string
}
export interface UserIdentityRepository {
  findById(id: string): TaskEither<UserIdentityGetError, UserIdentity>
  findByUserId(userId: string): TaskEither<UserIdentityGetError, ReadonlyArray<UserIdentity>>
  findByProviderAndSubject(providerId: string, subjectId: string): TaskEither<UserIdentityGetError, UserIdentity>
  create(userIdentity: UserIdentityCreate): TaskEither<UserIdentityCreateError, UserIdentity>
}
```

### app/services/src/workflow/interfaces.ts

```typescript
export interface WorkflowRepository {
  createWorkflow(
    data: CreateWorkflowRepo
  ): TaskEither<CreateWorkflowRepoError | WorkflowValidationError | WorkflowTemplateValidationError, Workflow>
  getWorkflowById<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>>
  getWorkflowByName<T extends WorkflowDecoratorSelector>(
    workflowName: string,
    includeRef?: T
  ): TaskEither<WorkflowGetError, DecoratedWorkflow<T>>
  listWorkflows<TInclude extends WorkflowDecoratorSelector>(
    request: ListWorkflowsRequestRepo<TInclude>
  ): TaskEither<WorkflowGetError, ListWorkflowsResponse<TInclude>>
  updateWorkflow<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    data: ConcurrentSafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>>
  updateWorkflowConcurrentSafe<T extends WorkflowDecoratorSelector>(
    workflowId: string,
    occCheck: bigint,
    data: ConcurrentUnsafeWorkflowUpdateData,
    includeRef?: T
  ): TaskEither<WorkflowUpdateError, DecoratedWorkflow<T>>
  countActiveWorkflowsByTemplateId(templateId: string): TaskEither<UnknownError, number>
  countActiveWorkflows(): TaskEither<UnknownError, number>
  getParentWorkflowTemplate(workflowId: string): TaskEither<WorkflowGetParentTemplateError, string>
  findExpiredWorkflows(now: Date, limit?: number): TaskEither<UnknownError, string[]>
  markWorkflowsAsRecalculationRequired(workflowIds: string[]): TaskEither<UnknownError, void>
}
export interface CreateWorkflowRequest extends RequestorAwareRequest {
  workflowData: {
    name: string
    description?: string
    workflowTemplateId: string
  }
}
export interface WorkflowSort {
  param: WorkflowSortParam
  order: SortOrder
}
export interface ListWorkflowsRequestRepo<TInclude extends WorkflowDecoratorSelector> {
  pagination?: {
    page: number
    limit: number
  }
  include?: TInclude
  sort?: WorkflowSort[]
  filters?: {
    includeOnlyNonTerminalState?: boolean
    templateId?: string
    workflowTemplateId?: string
    workflowTemplateName?: string
    includeGroups?: string[]
  }
}
export interface ListWorkflowsRequest<TInclude extends WorkflowDecoratorSelector>
  extends RequestorAwareRequest, Omit<ListWorkflowsRequestRepo<TInclude>, "filters" | "sort"> {
  filters?: {
    includeOnlyNonTerminalState?: boolean
    workflowTemplateIdentifier?: string
    includeGroups?: string[]
  }
  sort?: WorkflowSort[]
}
export interface ListWorkflowsResponse<TInclude extends WorkflowDecoratorSelector> {
  workflows: ReadonlyArray<DecoratedWorkflow<TInclude>>
  pagination: {
    total: number
    page: number
    limit: number
  }
}
```

### app/services/src/feature-gate/interfaces.ts

```typescript
export interface EffectiveEntitlements {
  readonly edition: DeploymentEdition
  readonly planTier: PlanTier
  readonly features: TierFeatures
}
```

### app/services/src/quota/interfaces.ts

```typescript
export interface ListQuotasResult {
  readonly items: Versioned<Quota>[]
  readonly total: number
  readonly page: number
  readonly limit: number
}
export interface QuotaRepository {
  getQuota(identifier: QuotaIdentifier): TaskEither<QuotaGetError, Versioned<Quota>>
  getQuotaById(id: string): TaskEither<QuotaGetError, Versioned<Quota>>
  createQuota(quota: Quota): TaskEither<QuotaCreateError, Versioned<Quota>>
  updateQuota(quota: Quota, occCheck: bigint): TaskEither<QuotaUpdateError, Versioned<Quota>>
  deleteQuota(id: string): TaskEither<QuotaDeleteError, void>
  listQuotas(page: number, limit: number, filter?: ListQuotasFilter): TaskEither<QuotaListError, ListQuotasResult>
}
```

### app/services/src/user/interfaces.ts

```typescript
export interface PaginatedUsersList {
  readonly users: ReadonlyArray<UserSummary>
  readonly page: number
  readonly limit: number
  readonly total: number
}
export interface UserRepository {
  createUser(user: User): TaskEither<UserCreateError, User>
  createUserWithOrgAdmin(user: User): TaskEither<UserCreateError, User>
  createUserWithIdentity(user: User, identity: UserIdentityCreate): TaskEither<UserCreateError, User>
  createUserWithOrgAdminAndIdentity(user: User, identity: UserIdentityCreate): TaskEither<UserCreateError, User>
  getUserById(userId: string): TaskEither<UserGetError, Versioned<User>>
  getUserByEmail(email: string): TaskEither<UserGetError, Versioned<User>>
  listUsers(params: ListUsersRepoRequest): TaskEither<UserListError, PaginatedUsersList>
  hasAnyOrganizationAdmins(): TaskEither<UnknownError, boolean>
  updateUser(user: Versioned<User>): TaskEither<UserUpdateError, User>
}
export interface ListUsersRepoRequest {
  readonly search?: string
  readonly page: number
  readonly limit: number
}
```

### app/services/src/email/email.interface.ts

```typescript
export interface EmailProviderExternal {
  sendEmail(email: Email): TaskEither<EmailExternalError, void>
}
export interface Email {
  to: string | string[]
  subject?: string
  htmlBody: string
}
```

### app/services/src/agent/interfaces.ts

```typescript
export interface AgentRepository {
  persistAgent(agent: Agent): TaskEither<AgentCreateError, Agent>
  getAgentById(agentId: string): TaskEither<AgentGetError, DecoratedAgent<{occ: true}>>
  getAgentByName(agentName: string): TaskEither<AgentGetError, Agent>
  updateAgent(agent: DecoratedAgent<{occ: true}>): TaskEither<AgentUpdateError, Agent>
}
```

### app/services/src/slack/interfaces.ts

```typescript
export interface SlackMessage {
  webhookUrl: string
  text: string
}
export interface SlackProviderExternal {
  sendSlackNotification(message: SlackMessage): TaskEither<SlackExternalError, void>
}
```

### app/services/src/group/interfaces.ts

```typescript
export interface ListGroupsResult {
  groups: GroupWithEntitiesCount[]
  total: number
  page: number
  limit: number
}
export interface GroupRepository {
  createGroupWithMembershipAndUpdateUser(
    data: CreateGroupWithMembershipAndUpdateUserRepo
  ): TaskEither<CreateGroupRepoError, Group>
  getGroupById(data: GetGroupByIdRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  getGroupByName(data: GetGroupByNameRepo): TaskEither<GetGroupRepoError, Versioned<GroupWithEntitiesCount>>
  getGroupIdByName(groupName: string): TaskEither<GetGroupRepoError, string>
  getGroupsByIds(groupIds: string[]): TaskEither<UnknownError, {id: string; name: string}[]>
  listGroups(data: ListGroupsRepo): TaskEither<ListGroupsRepoError, ListGroupsResult>
  getGroupsByUserId(userId: string): TaskEither<GetGroupRepoError, Group[]>
  getGroupsByAgentId(agentId: string): TaskEither<GetGroupRepoError, Group[]>
  countGroups(): TaskEither<UnknownError, number>
}
export interface CreateGroupWithMembershipAndUpdateUserRepo {
  group: Group
  user: User
  userOcc: bigint
  membership: Membership
}
export interface ListGroupsRepo {
  filter: ListGroupsFilter
  page: number
  limit: number
}
export interface GetGroupByIdRepo {
  groupId: string
}
export interface GetGroupByNameRepo {
  groupName: string
}
```

### app/services/src/audit-log/interfaces.ts

```typescript
export interface AuditLogRepository {
  persist(data: CreateAuditLog): TaskEither<UnknownError, void>
  findMany(
    limit: number,
    fromDate: Date,
    cursor: string | undefined,
    filters: {
      targets?: Array<{entityType: string; entityId: string}>
      actors?: Array<{actorType: string; actorId: string}>
      auditTypes?: string[]
    }
  ): TaskEither<FindManyError, ListAuditLogResponse>
}
```

### app/services/src/group-membership/interfaces.ts

```typescript
export interface AddMembershipRepoRequest {
  readonly group: Versioned<Group>
  readonly memberships: ReadonlyArray<Membership>
}
export interface RemoveMembershipRepoRequest {
  readonly groupId: string
  readonly entityReferences: ReadonlyArray<EntityReference>
}
interface GroupMembershipResult {
  readonly group: Versioned<Group>
  readonly memberships: ReadonlyArray<Membership>
}
export interface GroupMembershipRepository {
  getGroupWithMembershipById(
    data: GetGroupWithMembershipRepo
  ): TaskEither<
    GetGroupRepoError | UserValidationError | MembershipValidationError | AgentKeyDecodeError | AgentValidationError,
    GetGroupMembershipResult
  >
  addMembershipsToGroup(request: AddMembershipRepoRequest): TaskEither<MembershipAddError, AddMembershipResult>
  removeMembershipFromGroup(
    request: RemoveMembershipRepoRequest
  ): TaskEither<MembershipRemoveError, RemoveMembershipResult>
  getUserMembershipsByUserId(
    userId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | UserValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  >
  getAgentMembershipsByAgentId(
    agentId: string
  ): TaskEither<
    MembershipValidationErrorWithGroupRef | AgentKeyDecodeError | AgentValidationError | UnknownError,
    ReadonlyArray<MembershipWithGroupRef>
  >
  countUserMembersByGroupId(groupId: string): TaskEither<UnknownError, number>
  countAgentMembersByGroupId(groupId: string): TaskEither<UnknownError, number>
}
export interface GetGroupWithMembershipRepo {
  groupId: string
  onlyIfMember: false | {userId: string}
}
```

## Database models

- `Databasechangelog` → `databasechangelog`
- `Databasechangeloglock` → `databasechangeloglock`
- `Group` → `groups`
- `GroupMembership` → `group_memberships`
- `User` → `users`
- `UserIdentity` → `user_identities`
- `Workflow` → `workflows`
- `WorkflowTemplate` → `workflow_templates`
- `Vote` → `votes`
- `WorkflowActionsEmailTask` → `workflow_actions_email_task`
- `PkceSession` → `pkce_sessions`
- `OrganizationAdmin` → `organization_admins`
- `Space` → `spaces`
- `Agent` → `agents`
- `AgentChallenge` → `agent_challenges`
- `AgentGroupMembership` → `agent_group_memberships`
- `WorkflowActionsWebhookTask` → `workflow_actions_webhook_tasks`
- `WorkflowActionsSlackTask` → `workflow_actions_slack_tasks`
- `RefreshToken` → `refresh_tokens`
- `Quota` → `quotas`
- `AuditLog` → `audit_logs`
- `UsageEvent` → `usage_events`

## OpenAPI operations

| Method | Current path | operationId | File |
| --- | --- | --- | --- |
| GET | `/health` | healthCheck | ./openapi/system/health.yaml |
| GET | `/auth/providers` | getAuthProviders | ./openapi/auth/auth-providers.yaml |
| GET | `/auth/web/login` | initiateLogin | ./openapi/auth/auth-web-login.yaml |
| POST | `/auth/cli/initiate` | initiateCliLogin | ./openapi/auth/auth-cli-initiate.yaml |
| GET | `/auth/web/callback` | webCallback | ./openapi/auth/auth-web-callback.yaml |
| POST | `/auth/web/refresh` | refreshUserTokenWeb | ./openapi/auth/auth-web-refresh.yaml |
| POST | `/auth/web/logout` | logoutUserWeb | ./openapi/auth/auth-web-logout.yaml |
| POST | `/auth/web/initiatePrivilegedTokenExchange` | initiatePrivilegeTokenWeb | ./openapi/auth/auth-web-initiatePrivilegedTokenExchange.yaml |
| POST | `/auth/web/exchangePrivilegedToken` | exchangePrivilegeTokenWeb | ./openapi/auth/auth-web-exchangePrivilegedToken.yaml |
| GET | `/auth/cli/initiatePrivilegedTokenExchange` | initiatePrivilegeTokenCli | ./openapi/auth/auth-cli-initiatePrivilegedTokenExchange.yaml |
| POST | `/auth/cli/exchangePrivilegedToken` | exchangePrivilegeTokenCli | ./openapi/auth/auth-cli-exchangePrivilegedToken.yaml |
| POST | `/auth/cli/token` | exchangeCliToken | ./openapi/auth/auth-cli-token.yaml |
| POST | `/auth/cli/refresh` | refreshCliToken | ./openapi/auth/auth-cli-refresh.yaml |
| GET | `/auth/info` | getEntityInfo | ./openapi/auth/auth-info.yaml |
| POST | `/auth/agents/challenge` | generateAgentChallenge | ./openapi/auth/auth-agents-challenge.yaml |
| POST | `/auth/agents/token` | exchangeAgentToken | ./openapi/auth/auth-agents-token.yaml |
| POST | `/auth/agents/refresh` | refreshAgentToken | ./openapi/auth/auth-agents-refresh.yaml |
| GET | `/agents` | listAgents | ./openapi/agents/agents.yaml |
| POST | `/agents/register` | registerAgent | ./openapi/agents/agents-register.yaml |
| GET | `/agents/{agentIdOrName}` | getAgent | ./openapi/agents/agents-agentIdOrName.yaml |
| PUT | `/agents/{agentId}/roles` | assignAgentRoles | ./openapi/agents/agents-agentId-roles.yaml |
| DELETE | `/agents/{agentId}/roles` | removeAgentRoles | ./openapi/agents/agents-agentId-roles.yaml |
| GET | `/roles` | listRoleTemplates | ./openapi/roles/roles.yaml |
| POST | `/workflows` | createWorkflow | ./openapi/workflows/workflows.yaml |
| GET | `/workflows` | listWorkflows | ./openapi/workflows/workflows.yaml |
| GET | `/workflows/{workflowId}` | getWorkflow | ./openapi/workflows/workflows-workflowId.yaml |
| POST | `/workflows/{workflowId}/vote` | voteOnWorkflow | ./openapi/workflows/workflows-workflowId-vote.yaml |
| GET | `/workflows/{workflowId}/votes` | getWorkflowVotes | ./openapi/workflows/workflows-workflowId-votes.yaml |
| GET | `/workflows/{workflowId}/canVote` | canVoteOnWorkflow | ./openapi/workflows/workflows-workflowId-canVote.yaml |
| POST | `/users` | createUser | ./openapi/users/users.yaml |
| GET | `/users` | listUsers | ./openapi/users/users.yaml |
| GET | `/users/{userId}` | getUser | ./openapi/users/users-userId.yaml |
| PUT | `/users/{userId}/roles` | assignUserRoles | ./openapi/users/users-userId-roles.yaml |
| DELETE | `/users/{userId}/roles` | removeUserRoles | ./openapi/users/users-userId-roles.yaml |
| POST | `/groups` | createGroup | ./openapi/groups/groups.yaml |
| GET | `/groups` | listGroups | ./openapi/groups/groups.yaml |
| GET | `/groups/{groupIdentifier}` | getGroup | ./openapi/groups/groups-groupIdentifier.yaml |
| GET | `/groups/{groupId}/entities` | listGroupEntities | ./openapi/groups/groups-groupId-entities.yaml |
| POST | `/groups/{groupId}/entities` | addGroupEntities | ./openapi/groups/groups-groupId-entities.yaml |
| DELETE | `/groups/{groupId}/entities` | removeGroupEntities | ./openapi/groups/groups-groupId-entities.yaml |
| POST | `/spaces` | createSpace | ./openapi/spaces/spaces.yaml |
| GET | `/spaces` | listSpaces | ./openapi/spaces/spaces.yaml |
| GET | `/spaces/{spaceId}` | getSpace | ./openapi/spaces/spaces-spaceId.yaml |
| DELETE | `/spaces/{spaceId}` | deleteSpace | ./openapi/spaces/spaces-spaceId.yaml |
| POST | `/organization/{organization-name}/admins` | addOrganizationAdminToOrg | ./openapi/org-admins/organization-organization-name-admins.yaml |
| GET | `/organization/{organization-name}/admins` | listOrganizationAdminsForOrg | ./openapi/org-admins/organization-organization-name-admins.yaml |
| DELETE | `/organization/{organization-name}/admins` | removeOrganizationAdminFromOrg | ./openapi/org-admins/organization-organization-name-admins.yaml |
| POST | `/workflow-templates` | createWorkflowTemplate | ./openapi/workflows/workflow-templates.yaml |
| GET | `/workflow-templates` | listWorkflowTemplates | ./openapi/workflows/workflow-templates.yaml |
| GET | `/workflow-templates/{templateIdentifier}` | getWorkflowTemplate | ./openapi/workflows/workflow-templates-templateIdentifier.yaml |
| PUT | `/workflow-templates/{templateIdentifier}` | updateWorkflowTemplate | ./openapi/workflows/workflow-templates-templateIdentifier.yaml |
| DELETE | `/workflow-templates/{templateIdentifier}` | deleteWorkflowTemplate | ./openapi/workflows/workflow-templates-templateIdentifier.yaml |
| POST | `/workflow-templates/{templateIdentifier}/deprecate` | deprecateWorkflowTemplate | ./openapi/workflows/workflow-templates-templateName-deprecate.yaml |
| GET | `/quotas` | listQuotas | ./openapi/quotas/quotas.yaml |
| POST | `/quotas` | createQuota | ./openapi/quotas/quotas.yaml |
| GET | `/quotas/{quotaId}` | getQuota | ./openapi/quotas/quotas-quotaId.yaml |
| PATCH | `/quotas/{quotaId}` | patchQuota | ./openapi/quotas/quotas-quotaId.yaml |
| DELETE | `/quotas/{quotaId}` | deleteQuota | ./openapi/quotas/quotas-quotaId.yaml |
| GET | `/audit-logs` | listAuditLogs | ./openapi/audit-logs/audit-logs.yaml |
| GET | `/audit-logs/me` | listMyAuditLogs | ./openapi/audit-logs/audit-logs-me.yaml |
| POST | `/resources/resolve` | resolveResources | ./openapi/resources/resources-resolve.yaml |
| GET | `/organizations/{orgId}/entitlements` | getOrganizationEntitlements | ./openapi/organizations/organizations-orgId-entitlements.yaml |
| GET | `/organizations/{orgId}/usage` | getOrganizationUsage | ./openapi/organizations/organizations-orgId-usage.yaml |

## Controller declarations, raw SQL, queues, Redis and encryption

Includes tests/helpers when they cross database or encryption boundaries. Matches are source locations requiring classification, not proof that every match is a tenant operation.

### app/worker/test/integration/workflow-events-queue-serialization.integration.test.ts

```text
119: const job = await queue.add("workflow-status-changed", event)
```

### app/worker/test/integration/test-helpers.ts

```text
26: @Process()
```

### app/worker/src/processor/workflow-action-slack.processor.ts

```text
14: @Processor(WORKFLOW_ACTION_SLACK_QUEUE)
22: @Process("workflow-action-slack")
```

### app/worker/src/processor/workflow-action-webhook.processor.ts

```text
14: @Processor(WORKFLOW_ACTION_WEBHOOK_QUEUE)
22: @Process("workflow-action-webhook")
```

### app/worker/src/processor/workflow-recalculation.processor.ts

```text
11: @Processor(WORKFLOW_STATUS_RECALCULATION_QUEUE)
15: @Process("recalculate-workflow")
```

### app/worker/src/processor/workflow-expiration-sweep.processor.ts

```text
8: import {WORKFLOW_EXPIRATION_SWEEP_QUEUE, RedisLock} from "@external"
10: @Processor(WORKFLOW_EXPIRATION_SWEEP_QUEUE)
19: @Process("sweep-expired-workflows")
32: const lock = new RedisLock(this.sweepQueue.client, lockKey, lockTtl)
```

### app/worker/src/processor/workflow-events.processor.ts

```text
31: @Processor(WORKFLOW_STATUS_CHANGED_QUEUE)
39: @Process("workflow-status-changed")
```

### app/worker/src/processor/workflow-action-email.processor.ts

```text
14: @Processor(WORKFLOW_ACTION_EMAIL_QUEUE)
22: @Process("workflow-action-email")
```

### app/test/mock-data.ts

```text
728: const encryptionResult = unwrapRight(await encryptionService.encrypt(plaintext)())
```

### app/test/database.ts

```text
21: await prismaClient.$executeRawUnsafe(`CREATE DATABASE "${databaseName}" TEMPLATE approvio;`)
60: await client.$executeRawUnsafe("DELETE FROM audit_logs;")
```

### app/external/test/database/pkce-session.repository.integration.test.ts

```text
62: const rawSessions = await prisma.$queryRawUnsafe<Record<string, string>[]>(
```

### app/external/test/database/workflow-template.repository.integration.test.ts

```text
86: const rawTemplates = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
```

### app/external/test/kms/encryption.service.test.ts

```text
16: const ciphertextBase64 = unwrapRight(await encryptionService.encrypt(plaintext)())
20: const decryptedPlaintext = unwrapRight(await encryptionService.decrypt(ciphertextBase64)())
26: const ciphertextBase64 = unwrapRight(await encryptionService.encrypt(plaintext)())
29: const decryptedPlaintext = unwrapRight(await encryptionService.decrypt(ciphertextBase64)())
```

### app/external/src/rate-limiter/rate-limiter.provider.ts

```text
31: keyPrefix: config.prefix
```

### app/external/src/kms/encryption.service.ts

```text
20: const {result} = await this.client.encrypt(this.kmsProvider.getKeyring(), plaintext)
38: const {plaintext} = await this.client.decrypt(this.kmsProvider.getKeyring(), buffer)
```

### app/external/src/auth/step-up-token.provider.ts

```text
9: private readonly keyPrefix = "step_up_token:"
16: const key = `${this.keyPrefix}${jti}`
30: const key = `${this.keyPrefix}${jti}`
```

### app/external/src/auth/dpop-token.provider.ts

```text
9: private readonly keyPrefix = "dpop_jti:"
16: const key = `${this.keyPrefix}${jti}`
```

### app/external/src/redis/redis-quota-admission.client.ts

```text
110: this.redis.defineCommand("reserveQuota", {
114: this.redis.defineCommand("settleQuota", {
118: this.redis.defineCommand("releaseQuota", {
```

### app/external/src/redis/redis-lock.ts

```text
5: interface RedisLockClient {
10: export type RedisLockError =
17: class RedisLockTimeoutError extends Error {
20: this.name = "RedisLockTimeoutError"
24: export class RedisLock {
26: private readonly redis: RedisLockClient,
35: acquire(): TE.TaskEither<RedisLockError, string> {
38: TE.tryCatch<RedisLockError, unknown>(
49: release(value: string): TE.TaskEither<RedisLockError, void> {
59: () => this.redis.eval(releaseScript, 1, this.key, value),
72: runLocked<E, T>(timeoutMs: number, fn: () => TE.TaskEither<E, T>): TE.TaskEither<RedisLockError | E, T> {
89: timeoutId = setTimeout(() => reject(new RedisLockTimeoutError()), timeoutMs)
98: (error): RedisLockError | E => {
99: if (error instanceof RedisLockTimeoutError) return {type: "operation_timeout"}
```

### app/main/src/auth/get-authenticated-entity.decorator.ts

```text
11: * @Controller('api')
13: *   @Get('protected')
```

### app/external/src/database/health.repository.ts

```text
13: await this.dbClient.prisma.$queryRaw`SELECT 1`
```

### app/external/src/queue/queue.provider.ts

```text
71: await this.queue.add(
99: await this.queue.addBulk(jobs)
111: await this.statusChangedQueue.add("workflow-status-changed", event, {
135: await this.emailActionQueue.add("workflow-action-email", event, payload)
138: await this.webhookActionQueue.add("workflow-action-webhook", event, payload)
141: await this.slackActionQueue.add("workflow-action-slack", event, payload)
184: await this.sweepQueue.add(
```

### app/controllers/src/resources/resources.controller.ts

```text
13: @Controller("resources")
17: @Post("resolve")
```

### app/external/src/database/workflow-template.repository.ts

```text
69: TE.chain(plaintext => encryptionService.encrypt(plaintext)),
96: encryptionService.decrypt(envelope.__encrypted_v1),
404: const result = await this.dbClient.cx.$queryRaw<{count: bigint}[]>(
```

### app/external/src/database/pkce-session.repository.ts

```text
18: this.encryptionService.encrypt(data.codeVerifier),
64: this.encryptionService.decrypt(session.codeVerifier),
96: this.encryptionService.encrypt(sessionData.codeVerifier),
```

### app/controllers/src/organizations/organization.controller.ts

```text
21: @Controller(ORGANIZATIONS_ENDPOINT_ROOT)
29: @Get(":orgId/entitlements")
52: @Get(":orgId/usage")
```

### app/controllers/src/organization-admin/organization-admin.controller.ts

```text
28: @Controller(ORGANIZATION_ADMIN_ENDPOINT_ROOT)
32: @Post(":organizationName/admins")
61: @Get(":organizationName/admins")
88: @Delete(":organizationName/admins")
```

### app/controllers/src/ping/ping.controller.ts

```text
4: @Controller("ping")
7: @Get()
```

### app/controllers/src/audit-logs/audit-logs.controller.ts

```text
42: @Controller(AUDIT_LOGS_ENDPOINT_ROOT)
46: @Get()
67: @Get("me")
```

### app/controllers/src/agents/agents.controller.ts

```text
37: @Controller(AGENTS_ENDPOINT_ROOT)
44: @Get(":idOrName")
57: @Post("register")
84: @Put(":agentId/roles")
114: @Delete(":agentId/roles")
```

### app/controllers/src/spaces/spaces.controller.ts

```text
23: @Controller(SPACES_ENDPOINT_ROOT)
27: @Post()
51: @Get()
82: @Get(":spaceId")
102: @Delete(":spaceId")
```

### app/controllers/src/workflows/workflows.controller.ts

```text
42: @Controller(WORKFLOWS_ENDPOINT_ROOT)
49: @Post()
80: @Get(":identifier")
100: @Get()
141: @Get(":workflowId/canVote")
166: @Post(":workflowId/vote")
193: @Get(":workflowId/votes")
```

### app/controllers/src/users/users.controller.ts

```text
41: @Controller(USERS_ENDPOINT_ROOT)
48: @Post()
74: @Get()
97: @Get(":userIdentifier")
111: @Put(":userId/roles")
140: @Delete(":userId/roles")
```

### app/controllers/src/roles/roles.controller.ts

```text
10: @Controller(ROLES_ENDPOINT_ROOT)
14: @Get()
```

### app/controllers/src/workflow-templates/workflow-templates.controller.ts

```text
39: @Controller(WORKFLOW_TEMPLATES_ENDPOINT_ROOT)
43: @Post()
76: @Get()
101: @Get(":templateIdentifier")
120: @Put(":templateIdentifier")
147: @Post(":templateIdentifier/deprecate")
```

### app/controllers/src/groups/groups.controller.ts

```text
58: @Controller(GROUPS_ENDPOINT_ROOT)
65: @Post()
89: @Get()
117: @Get(":groupIdentifier")
136: @Get(":groupId/entities")
170: @Post(":groupId/entities")
202: @Delete(":groupId/entities")
```

### app/controllers/src/internal/workflow-templates/workflow-templates.internal.controller.ts

```text
10: @Controller(WORKFLOW_TEMPLATE_INTERNAL_ENDPOINT_ROOT)
14: @Post("/:templateId/cancel-workflows")
```

### app/controllers/src/internal/health/health.controller.ts

```text
11: @Controller("internal/health")
17: @Get()
```

### app/controllers/src/auth/cli-auth.controller.ts

```text
27: @Controller("auth/cli")
32: @Post("initiate")
50: @Post("token")
68: @Post("refresh")
88: @Get("initiatePrivilegedTokenExchange")
104: @Post("exchangePrivilegedToken")
```

### app/controllers/src/auth/auth-providers.controller.ts

```text
6: @Controller("auth/providers")
12: @Get()
```

### app/controllers/src/auth/auth.controller.ts

```text
49: @Controller("auth")
56: @Get("info")
75: @Post("agents/challenge")
96: @Post("agents/token")
120: @Post("agents/refresh")
```

### app/controllers/src/auth/web-auth.controller.ts

```text
38: @Controller("auth/web")
47: @Get("login")
71: @Get("callback")
91: @Post("refresh")
111: @Post("initiatePrivilegedTokenExchange")
129: @Post("exchangePrivilegedToken")
164: @Post("logout")
```

### app/domain/test/approval-rules.test.ts

```text
227: groupVoters.get(groupId)!.add(getNormalizedEntityId(vote.voter))
```

### app/controllers/src/quotas/quotas.controller.ts

```text
31: @Controller(QUOTAS_ENDPOINT_ROOT)
35: @Post()
57: @Get()
79: @Get(":id")
92: @Patch(":id")
112: @Delete(":id")
```

### app/domain/src/role.ts

```text
226: seen.add(roleKey)
```

### app/services/src/role/role.service.ts

```text
85: seenRoles.add(roleKey)
```

### app/domain/src/workflows.ts

```text
221: if (vote.type === "VETO") activeVetoers.add(voterKey)
225: groupVoters.get(groupId)!.add(voterKey)
```

### app/services/src/usage-metering/usage-metering.service.ts

```text
53: const key = this.buildAdmissionKey(params.orgId, params.metric, params.period)
131: const key = this.buildAdmissionKey(params.orgId, params.metric, params.period)
173: const key = this.buildAdmissionKey(params.orgId, params.metric, params.period)
237: const key = this.buildAdmissionKey(orgId, metric, period)
266: private buildAdmissionKey(orgId: string, metric: UsageMetric, period: string): string {
```
