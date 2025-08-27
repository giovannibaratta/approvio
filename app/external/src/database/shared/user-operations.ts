import {BoundRole} from "@domain"
import {Prisma} from "@prisma/client"

export interface UpdateUserWithRolesData {
  userId: string
  userOcc: bigint
  displayName: string
  email: string
  roles: ReadonlyArray<BoundRole<string>>
  createdAt: Date
}

/**
 * Update user with roles using optimistic concurrency control.
 */
export async function persistExistingUserRaceConditionFree(
  tx: Prisma.TransactionClient,
  data: UpdateUserWithRolesData
): Promise<void> {
  await tx.user.update({
    where: {
      id: data.userId,
      occ: data.userOcc
    },
    data: {
      displayName: data.displayName,
      email: data.email,
      roles: mapRolesToJsonValue(data.roles),
      createdAt: data.createdAt,
      occ: {
        increment: 1
      }
    }
  })
}

function mapRolesToJsonValue(roles: ReadonlyArray<BoundRole<string>>): Prisma.InputJsonValue {
  return roles.map(role => ({
    name: role.name,
    permissions: [...role.permissions],
    scope: {
      type: role.scope.type,
      ...(role.scope.type === "space" && {spaceId: role.scope.spaceId}),
      ...(role.scope.type === "group" && {groupId: role.scope.groupId}),
      ...(role.scope.type === "workflow_template" && {workflowTemplateId: role.scope.workflowTemplateId})
    }
  }))
}
