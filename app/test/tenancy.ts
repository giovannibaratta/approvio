import {PrismaClient} from "@prisma/client"
import {v7 as uuidv7} from "uuid"
import {OrganizationId} from "@domain"
import {randomOrgId} from "./organization-id"

export interface TwoOrganizationFixture {
  readonly accountId: string
  readonly removedAccountId: string
  readonly organizationA: {readonly id: OrganizationId; readonly userId: string; readonly agentId: string}
  readonly organizationB: {readonly id: OrganizationId; readonly userId: string; readonly agentId: string}
  readonly removedUserId: string
}

export async function seedTwoOrganizationFixture(prisma: PrismaClient): Promise<TwoOrganizationFixture> {
  const now = new Date()
  const accountId = uuidv7()
  const removedAccountId = uuidv7()
  const organizationA = {id: randomOrgId(), userId: uuidv7(), agentId: uuidv7()}
  const organizationB = {id: randomOrgId(), userId: uuidv7(), agentId: uuidv7()}
  const removedUserId = uuidv7()

  await prisma.organization.createMany({
    data: [
      {
        id: organizationA.id,
        slug: `org-a-${organizationA.id.slice(-8)}`,
        displayName: "Organization A",
        planTier: "FREE",
        status: "active",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      },
      {
        id: organizationB.id,
        slug: `org-b-${organizationB.id.slice(-8)}`,
        displayName: "Organization B",
        planTier: "FREE",
        status: "active",
        occ: 0n,
        createdAt: now,
        updatedAt: now
      }
    ]
  })
  await prisma.platformAccount.createMany({
    data: [
      {
        id: accountId,
        displayName: "Shared Account",
        profileEmail: "shared@example.com",
        status: "active",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      },
      {
        id: removedAccountId,
        displayName: "Removed Account",
        profileEmail: "removed@example.com",
        status: "active",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      }
    ]
  })
  await prisma.user.createMany({
    data: [
      {
        id: organizationA.userId,
        organizationId: organizationA.id,
        platformAccountId: accountId,
        displayName: "Shared Account in A",
        status: "active",
        orgRole: "owner",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      },
      {
        id: organizationB.userId,
        organizationId: organizationB.id,
        platformAccountId: accountId,
        displayName: "Shared Account in B",
        status: "active",
        orgRole: "owner",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      },
      {
        id: removedUserId,
        organizationId: organizationA.id,
        platformAccountId: removedAccountId,
        displayName: "Removed User",
        status: "removed",
        orgRole: "member",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      }
    ]
  })
  await prisma.agent.createMany({
    data: [
      {
        id: organizationA.agentId,
        organizationId: organizationA.id,
        agentName: "agent-a",
        base64PublicKey: "fixture-public-key-a",
        status: "active",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      },
      {
        id: organizationB.agentId,
        organizationId: organizationB.id,
        agentName: "agent-b",
        base64PublicKey: "fixture-public-key-b",
        status: "active",
        createdAt: now,
        updatedAt: now,
        occ: 0n
      }
    ]
  })
  await prisma.group.createMany({
    data: [
      {id: uuidv7(), organizationId: organizationA.id, name: "shared-name", createdAt: now, updatedAt: now, occ: 0n},
      {id: uuidv7(), organizationId: organizationB.id, name: "shared-name", createdAt: now, updatedAt: now, occ: 0n}
    ]
  })

  return {accountId, removedAccountId, organizationA, organizationB, removedUserId}
}
