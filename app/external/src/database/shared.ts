import {Agent, AgentFactory, AgentValidationError, User, UserFactory, UserValidationError, Versioned} from "@domain"
import {Agent as PrismaAgent, Prisma, User as PrismaUser} from "@prisma/client"
import * as E from "fp-ts/Either"
import {Either} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import {UnconstrainedBoundRole} from "@domain"
import {AgentKeyDecodeError} from "@services"

export async function persistExistingUserRaceConditionFree(
  tx: Pick<Prisma.TransactionClient, "user">,
  data: UpdateUserWithRolesData
): Promise<E.Either<"user_not_found" | "concurrency_error", void>> {
  const updated = await tx.user.updateMany({
    where: {
      id: data.userId,
      organizationId: data.organizationId,
      occ: data.userOcc
    },
    data: {
      displayName: data.displayName,
      roles: mapRolesToPrisma(data.roles),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      occ: {increment: 1}
    }
  })
  if (updated.count === 1) return E.right(undefined)

  // Diagnose only a missed guarded update. Keep the tenant predicate so a foreign ID
  // is indistinguishable from an absent user; the original OCC check remains atomic.
  const user = await tx.user.findUnique({
    where: {organizationId_id: {organizationId: data.organizationId, id: data.userId}},
    select: {id: true}
  })
  return E.left(user === null ? "user_not_found" : "concurrency_error")
}

export function mapToDomainVersionedUser(dbObject: PrismaUser): Either<UserValidationError, Versioned<User>> {
  return pipe(
    dbObject,
    mapUserToDomain,
    E.map(user => ({...user, occ: dbObject.occ}))
  )
}

export function mapUserToDomain(dbObject: PrismaUser): Either<UserValidationError, User> {
  const object = {
    id: dbObject.id,
    organizationId: dbObject.organizationId,
    accountId: dbObject.platformAccountId,
    displayName: dbObject.displayName,
    status: dbObject.status,
    orgRole: dbObject.orgRole,
    roles: dbObject.roles,
    createdAt: dbObject.createdAt,
    updatedAt: dbObject.updatedAt
  }

  return pipe(object, obj => UserFactory.validate(obj))
}

export function mapAgentToDomain(dbObject: PrismaAgent): Either<AgentKeyDecodeError | AgentValidationError, Agent> {
  const decodePublicKey = E.tryCatch(
    () => Buffer.from(dbObject.base64PublicKey, "base64").toString("utf8"),
    () => "agent_key_decode_error" as const
  )

  return pipe(
    decodePublicKey,
    E.map(decodedPublicKey => {
      const agent = {
        id: dbObject.id,
        organizationId: dbObject.organizationId,
        agentName: dbObject.agentName,
        publicKey: decodedPublicKey,
        status: dbObject.status,
        roles: dbObject.roles,
        createdAt: dbObject.createdAt,
        updatedAt: dbObject.updatedAt
      }
      return agent
    }),
    E.chainW(agentToValidate => AgentFactory.validate(agentToValidate))
  )
}

export function mapRolesToPrisma(roles: Iterable<UnconstrainedBoundRole>): Prisma.JsonArray {
  return [...roles].map(role => mapRoleToPrisma(role))
}

function mapRoleToPrisma(role: UnconstrainedBoundRole): Prisma.JsonObject {
  return {
    name: role.name,
    resourceType: role.resourceType,
    permissions: [...role.permissions],
    scopeType: role.scopeType,
    scope: mapScopeToPrisma(role.scope)
  }
}

function mapScopeToPrisma(scope: UnconstrainedBoundRole["scope"]): Prisma.JsonObject {
  switch (scope.type) {
    case "group":
      return {
        type: scope.type,
        organizationId: scope.organizationId,
        groupId: scope.groupId
      }
    case "space":
      return {
        type: scope.type,
        organizationId: scope.organizationId,
        spaceId: scope.spaceId
      }
    case "workflow_template":
      return {
        type: scope.type,
        organizationId: scope.organizationId,
        templateName: scope.templateName
      }
    case "org":
      return {
        type: scope.type,
        organizationId: scope.organizationId
      }
  }
}

interface UpdateUserWithRolesData {
  readonly userId: string
  readonly organizationId: User["organizationId"]
  readonly userOcc: bigint
  readonly displayName: string
  readonly roles: User["roles"]
  readonly createdAt: Date
  readonly updatedAt: Date
}
