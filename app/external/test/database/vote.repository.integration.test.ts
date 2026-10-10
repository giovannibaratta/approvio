import {UserFactory} from "@domain"
import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {OrgRole, VoteFactory} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {MembershipDbRepository} from "@external/database/membership.repository"
import {MembershipTenantClient, VoteTenantClient} from "@external/database/tenant-database-clients"
import {VoteDbRepository} from "@external/database/vote.repository"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {createTestUser} from "@test/user"

describe("VoteDbRepository integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let repository: VoteDbRepository
  let membershipRepository: MembershipDbRepository
  let organizationId: ReturnType<typeof toOrganizationId>
  let workflowId: string
  let userId: string

  beforeEach(async () => {
    const connectionString = await prepareDatabase()
    database = new DatabaseClient({
      databaseConfig: {
        tenantConnectionUrl: connectionString,
        platformConnectionUrl: connectionString,
        retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
      }
    })
    prisma = createFixturePrismaClient(connectionString)
    repository = new VoteDbRepository(new VoteTenantClient(database))
    membershipRepository = new MembershipDbRepository(new MembershipTenantClient(database))
    organizationId = randomOrgId()
    const seed = await createWorkflowAndUser(prisma, organizationId)
    workflowId = seed.workflowId
    userId = seed.userId
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("persists a tenant-qualified vote and marks only its workflow for recalculation", async () => {
    const vote = unwrapRight(
      VoteFactory.newVote({
        organizationId,
        workflowId,
        voter: {organizationId, entityId: userId, entityType: "user"},
        type: "APPROVE",
        votedForGroups: [uuidv7()]
      })
    )
    const saved = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.persistVoteAndMarkWorkflowRecalculation({organizationId}, vote)()
      )
    )
    expect(saved).toMatchObject({id: vote.id, organizationId, workflowId})
    expect(
      (await prisma.workflow.findUnique({where: {organizationId_id: {organizationId, id: workflowId}}}))
        ?.recalculationRequired
    ).toBe(true)

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const foreign = unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.getVotesByWorkflowId({organizationId: otherOrganizationId}, workflowId)()
      )
    )
    expect(foreign).toEqual([])
  })

  it("retains historical voter attribution after local membership removal", async () => {
    const context = {organizationId}
    const vote = unwrapRight(
      VoteFactory.newVote({
        organizationId,
        workflowId,
        voter: {organizationId, entityId: userId, entityType: "user"},
        type: "APPROVE",
        votedForGroups: []
      })
    )
    unwrapRight(
      await database.transactional(organizationId, () =>
        repository.persistVoteAndMarkWorkflowRecalculation(context, vote)()
      )
    )

    await database.transactional(organizationId, async () => {
      const previous = unwrapRight(await membershipRepository.getById(context, userId)())
      const removed = unwrapRight(UserFactory.remove(previous.membership))
      unwrapRight(await membershipRepository.update(context, previous, removed)())
    })

    const retainedVotes = unwrapRight(
      await database.transactional(organizationId, () => repository.getVotesByWorkflowId(context, workflowId)())
    )
    expect(retainedVotes).toMatchObject([
      {
        id: vote.id,
        voter: {entityId: userId, entityType: "user", organizationId}
      }
    ])
  })
})

async function createWorkflowAndUser(
  prisma: PrismaClient,
  organizationId: string
): Promise<{workflowId: string; userId: string}> {
  const now = new Date()
  const accountId = uuidv7()
  const user = unwrapRight(createTestUser({organizationId, accountId, displayName: "Voter", orgRole: OrgRole.MEMBER}))
  const spaceId = uuidv7()
  const templateId = uuidv7()
  const workflowId = uuidv7()
  await prisma.organization.create({data: organization(organizationId)})
  await prisma.platformAccount.create({
    data: {
      id: accountId,
      displayName: "Account",
      profileEmail: "account@example.com",
      status: "active",
      createdAt: now,
      updatedAt: now,
      occ: 0n
    }
  })
  await prisma.user.create({
    data: {
      id: user.id,
      organizationId,
      platformAccountId: accountId,
      displayName: user.displayName,
      status: user.status,
      orgRole: user.orgRole,
      roles: [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      occ: 0n
    }
  })
  await prisma.space.create({
    data: {
      id: spaceId,
      organizationId,
      name: `space-${spaceId}`,
      description: null,
      createdAt: now,
      updatedAt: now,
      occ: 0n
    }
  })
  await prisma.workflowTemplate.create({
    data: {
      id: templateId,
      organizationId,
      name: `template-${templateId}`,
      description: null,
      approvalRule: {type: "GROUP_REQUIREMENT", groupId: uuidv7(), minCount: 1},
      encActions: null,
      defaultExpiresInHours: null,
      createdAt: now,
      updatedAt: now,
      status: "ACTIVE",
      version: 1,
      allowVotingOnDeprecatedTemplate: false,
      occ: 0n,
      spaceId
    }
  })
  await prisma.workflow.create({
    data: {
      id: workflowId,
      organizationId,
      name: `workflow-${workflowId}`,
      description: null,
      createdAt: now,
      updatedAt: now,
      status: "PENDING",
      occ: 0n,
      recalculationRequired: false,
      workflowTemplateId: templateId,
      expiresAt: new Date(now.getTime() + 60_000)
    }
  })
  return {workflowId, userId: user.id}
}

function organization(id: string) {
  const now = new Date()
  return {
    id,
    slug: `test-${id}`,
    displayName: "Test organization",
    planTier: "FREE",
    status: "active",
    occ: 0n,
    createdAt: now,
    updatedAt: now
  }
}
