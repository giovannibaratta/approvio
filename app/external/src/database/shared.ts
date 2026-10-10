// Persistence mappings perform only storage-shape checks that are required to construct a domain
// value. Business invariants remain in the domain factories; invalid records are rejected there
// instead of being silently normalized by the repository.

import {Agent, AgentFactory, AgentValidationError, User, UserFactory, UserValidationError, Versioned} from "@domain"
import {Agent as PrismaAgent, Prisma, User as PrismaUser} from "@prisma/client"
import * as E from "fp-ts/Either"
import {Either} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {UnconstrainedBoundRole} from "@domain"

export type AgentKeyDecodeError = "agent_key_decode_error"

/** Maps a current tenant-local user row without reviving removed email/admin joins. */
export function mapToDomainVersionedUser(record: PrismaUser): Either<UserValidationError, Versioned<User>> {
  const validated: Either<UserValidationError, User> = UserFactory.validate({
    id: record.id,
    organizationId: record.organizationId,
    accountId: record.platformAccountId,
    displayName: record.displayName,
    status: record.status,
    orgRole: record.orgRole,
    roles: record.roles,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  })
  return pipe(
    validated,
    E.map((user): Versioned<User> => ({...user, occ: record.occ}))
  )
}

export function mapAgentToDomain(record: PrismaAgent): Either<AgentKeyDecodeError | AgentValidationError, Agent> {
  return pipe(
    E.tryCatch(
      () => Buffer.from(record.base64PublicKey, "base64").toString("utf8"),
      () => "agent_key_decode_error" as const
    ),
    E.chainW(publicKey =>
      AgentFactory.validate({
        id: record.id,
        organizationId: record.organizationId,
        agentName: record.agentName,
        publicKey,
        status: record.status,
        roles: record.roles,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      })
    )
  )
}

export function mapRolesToPrisma(roles: Iterable<UnconstrainedBoundRole>): Prisma.JsonArray {
  return [...roles].map(role => ({
    name: role.name,
    resourceType: role.resourceType,
    permissions: [...role.permissions],
    scopeType: role.scopeType,
    scope: mapScope(role.scope)
  }))
}

function mapScope(scope: UnconstrainedBoundRole["scope"]): Prisma.JsonObject {
  switch (scope.type) {
    case "group":
      return {type: scope.type, organizationId: scope.organizationId, groupId: scope.groupId}
    case "space":
      return {type: scope.type, organizationId: scope.organizationId, spaceId: scope.spaceId}
    case "workflow_template":
      return {type: scope.type, organizationId: scope.organizationId, templateName: scope.templateName}
    case "org":
      return {type: scope.type, organizationId: scope.organizationId}
  }
}
