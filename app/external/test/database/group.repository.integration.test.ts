import {randomOrgId, toOrganizationId} from "@test/organization-id"
import {
  AgentFactory,
  createAgentMembershipEntity,
  createUserMembershipEntity,
  GroupFactory,
  MembershipFactory,
  OrgRole,
  User,
  UserFactory
} from "@domain"
import {DatabaseClient} from "@external/database/database-client"
import {GroupMembershipTenantClient, GroupTenantClient} from "@external/database/tenant-database-clients"
import {GroupDbRepository} from "@external/database/group.repository"
import {GroupMembershipDbRepository} from "@external/database/group-membership.repository"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {PrismaClient} from "@prisma/client"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {createDomainMockUserInDb} from "@test/mock-data"
import {createTestUser} from "@test/user"

describe("GroupDbRepository integration", () => {
  let prisma: PrismaClient
  let database: DatabaseClient
  let repository: GroupDbRepository
  let membershipRepository: GroupMembershipDbRepository
  let transactionManager: PrismaTransactionManager
  let organizationId: ReturnType<typeof toOrganizationId>
  let accountId: string

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
    repository = new GroupDbRepository(new GroupTenantClient(database))
    membershipRepository = new GroupMembershipDbRepository(new GroupMembershipTenantClient(database))
    transactionManager = new PrismaTransactionManager(database)
    organizationId = randomOrgId()
    accountId = uuidv7()
    await prisma.organization.create({data: organization(organizationId)})
    await prisma.platformAccount.create({data: account(accountId)})
  }, 30_000)

  afterEach(async () => {
    if (!prisma) return
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await database.onModuleDestroy()
  })

  it("keeps group names and reads tenant-qualified", async () => {
    const context = {organizationId}
    const user = unwrapRight(
      createTestUser({organizationId, accountId, displayName: "Member", orgRole: OrgRole.MEMBER})
    )
    await database.transactional(organizationId, () => repositoryUserCreate(database, user))
    const group = unwrapRight(GroupFactory.newGroup({organizationId, name: "Shared", description: null}))
    const membership = unwrapRight(MembershipFactory.newMembership({entity: createUserMembershipEntity(user)}))

    const created = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.createGroupWithMembershipAndUpdateUser(context, {group, user, userOcc: 0n, membership})()
      )
    )
    expect(created).toMatchObject({id: group.id, organizationId, name: "Shared"})
    expect(
      unwrapRight(
        await database.transactional(organizationId, () => repository.getGroupByName(context, {groupName: "Shared"})())
      )
    ).toMatchObject({id: group.id, entitiesCount: 1})

    const otherOrganizationId = randomOrgId()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    const foreign = await database.transactional(otherOrganizationId, () =>
      repository.getGroupById({organizationId: otherOrganizationId}, {groupId: group.id})()
    )
    expect(foreign).toBeLeftOf("group_not_found")
  })

  it("allows the same group name in another organization but rejects a local duplicate", async () => {
    const user = unwrapRight(
      createTestUser({organizationId, accountId, displayName: "Member", orgRole: OrgRole.MEMBER})
    )
    await database.transactional(organizationId, () => repositoryUserCreate(database, user))
    const group = unwrapRight(GroupFactory.newGroup({organizationId, name: "Duplicate", description: null}))
    const membership = unwrapRight(MembershipFactory.newMembership({entity: createUserMembershipEntity(user)}))
    unwrapRight(
      await database.transactional(organizationId, () =>
        repository.createGroupWithMembershipAndUpdateUser({organizationId}, {group, user, userOcc: 0n, membership})()
      )
    )

    const duplicate = unwrapRight(GroupFactory.newGroup({organizationId, name: "Duplicate", description: null}))
    const rejected = await database.transactional(organizationId, () =>
      repository.createGroupWithMembershipAndUpdateUser(
        {organizationId},
        {group: duplicate, user, userOcc: 1n, membership}
      )()
    )
    expect(rejected).toBeLeftOf("group_already_exists")

    const otherOrganizationId = randomOrgId()
    const otherAccountId = uuidv7()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    await prisma.platformAccount.create({data: account(otherAccountId)})
    const otherUser = unwrapRight(
      createTestUser({
        organizationId: otherOrganizationId,
        accountId: otherAccountId,
        displayName: "Other",
        orgRole: OrgRole.MEMBER
      })
    )
    await database.transactional(otherOrganizationId, () => repositoryUserCreate(database, otherUser))
    const otherGroup = unwrapRight(
      GroupFactory.newGroup({organizationId: otherOrganizationId, name: "Duplicate", description: null})
    )
    const otherMembership = unwrapRight(
      MembershipFactory.newMembership({entity: createUserMembershipEntity(otherUser)})
    )
    unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.createGroupWithMembershipAndUpdateUser(
          {organizationId: otherOrganizationId},
          {group: otherGroup, user: otherUser, userOcc: 0n, membership: otherMembership}
        )()
      )
    )

    const otherGroupByName = unwrapRight(
      await database.transactional(otherOrganizationId, () =>
        repository.getGroupByName({organizationId: otherOrganizationId}, {groupName: "Duplicate"})()
      )
    )
    const foreignBulkRead = unwrapRight(
      await database.transactional(organizationId, () => repository.getGroupsByIds({organizationId}, [otherGroup.id])())
    )
    const foreignMemberGroups = unwrapRight(
      await database.transactional(organizationId, () => repository.getGroupsByUserId({organizationId}, otherUser.id)())
    )
    const localMemberGroups = unwrapRight(
      await database.transactional(organizationId, () => repository.getGroupsByUserId({organizationId}, user.id)())
    )
    const localList = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.listGroups({organizationId}, {filter: {type: "all", search: "Duplicate"}, page: 1, limit: 10})()
      )
    )
    const byNameId = unwrapRight(
      await database.transactional(organizationId, () => repository.getGroupIdByName({organizationId}, "Duplicate")())
    )
    const groupCount = unwrapRight(
      await database.transactional(organizationId, () => repository.countGroups({organizationId})())
    )
    const mixedBulk = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.getGroupsByIds({organizationId}, [group.id, otherGroup.id])()
      )
    )
    const directList = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.listGroups(
          {organizationId},
          {
            filter: {type: "direct_member", requestor: user, search: "Duplicate"},
            page: 1,
            limit: 10
          }
        )()
      )
    )
    const foreignDirectList = unwrapRight(
      await database.transactional(organizationId, () =>
        repository.listGroups(
          {organizationId},
          {
            filter: {type: "direct_member", requestor: otherUser},
            page: 1,
            limit: 10
          }
        )()
      )
    )
    const foreignInclude = await database.transactional(organizationId, () =>
      membershipRepository.getGroupWithMembershipById({organizationId}, {groupId: otherGroup.id, onlyIfMember: false})()
    )
    const foreignCount = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.countUserMembersByGroupId({organizationId}, otherGroup.id)()
      )
    )
    expect(byNameId).toBe(group.id)
    expect(groupCount).toBe(1)
    expect(mixedBulk).toEqual([{id: group.id, name: group.name}])
    expect(directList.groups.map(item => item.id)).toEqual([group.id])
    expect(directList.total).toBe(1)
    expect(foreignDirectList.groups).toEqual([])
    expect(foreignDirectList.total).toBe(0)
    expect(foreignInclude).toBeLeftOf("group_not_found")
    expect(foreignCount).toBe(0)
    expect(otherGroupByName.id).toBe(otherGroup.id)
    expect(foreignBulkRead).toEqual([])
    expect(foreignMemberGroups).toEqual([])
    expect(localMemberGroups.map(item => item.id)).toContain(group.id)
    expect(localList.groups.map(item => item.id)).toEqual([group.id])
    expect(localList.total).toBe(1)
  })

  it("rejects cross-organization members when adding to or removing from a group", async () => {
    const context = {organizationId}
    const localUser = unwrapRight(
      createTestUser({organizationId, accountId, displayName: "Local", orgRole: OrgRole.MEMBER})
    )
    await database.transactional(organizationId, () => repositoryUserCreate(database, localUser))

    const otherOrganizationId = randomOrgId()
    const otherAccountId = uuidv7()
    await prisma.organization.create({data: organization(otherOrganizationId)})
    await prisma.platformAccount.create({data: account(otherAccountId)})
    const foreignUser = unwrapRight(
      createTestUser({
        organizationId: otherOrganizationId,
        accountId: otherAccountId,
        displayName: "Foreign",
        orgRole: OrgRole.MEMBER
      })
    )
    await database.transactional(otherOrganizationId, () => repositoryUserCreate(database, foreignUser))

    const group = unwrapRight(GroupFactory.newGroup({organizationId, name: "Scoped", description: null}))
    const localMembership = unwrapRight(
      MembershipFactory.newMembership({entity: createUserMembershipEntity(localUser)})
    )
    unwrapRight(
      await database.transactional(organizationId, () =>
        repository.createGroupWithMembershipAndUpdateUser(context, {
          group,
          user: localUser,
          userOcc: 0n,
          membership: localMembership
        })()
      )
    )
    const snapshot = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.getGroupWithMembershipById(context, {groupId: group.id, onlyIfMember: false})()
      )
    )
    const additionalUser = await createDomainMockUserInDb(prisma, {organizationId})
    const additionalMembership = unwrapRight(
      MembershipFactory.newMembership({entity: createUserMembershipEntity(additionalUser)})
    )
    const forgedForeign = unwrapRight(UserFactory.validate({...foreignUser, organizationId}))
    const forgedMembership = unwrapRight(
      MembershipFactory.newMembership({entity: createUserMembershipEntity(forgedForeign)})
    )
    // The first local INSERT must roll back when the second, forged reference fails its tenant FK.
    const mixedAdd = await transactionManager.execute(context, () =>
      membershipRepository.addMembershipsToGroup(context, {
        group: snapshot.group,
        memberships: [additionalMembership, forgedMembership]
      })
    )()
    expect(mixedAdd).toBeLeftOf("unknown_error")
    expect(await prisma.groupMembership.count({where: {groupId: group.id, userId: additionalUser.id}})).toBe(0)
    expect((await prisma.group.findUniqueOrThrow({where: {id: group.id}})).occ).toBe(snapshot.group.occ)
    const foreignMembership = unwrapRight(
      MembershipFactory.newMembership({entity: createUserMembershipEntity(foreignUser)})
    )
    const foreignAgent = unwrapRight(AgentFactory.create({organizationId: otherOrganizationId, agentName: "Foreign"}))
    await prisma.agent.create({
      data: {
        id: foreignAgent.id,
        organizationId: otherOrganizationId,
        agentName: foreignAgent.agentName,
        base64PublicKey: Buffer.from(foreignAgent.publicKey).toString("base64"),
        status: foreignAgent.status,
        roles: [],
        createdAt: foreignAgent.createdAt,
        updatedAt: foreignAgent.updatedAt,
        occ: 0n
      }
    })
    const foreignGroup = await prisma.group.create({
      data: {
        id: uuidv7(),
        organizationId: otherOrganizationId,
        name: "Foreign group",
        description: null,
        occ: 0n,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    await prisma.agentGroupMembership.create({
      data: {
        organizationId: otherOrganizationId,
        groupId: foreignGroup.id,
        agentId: foreignAgent.id,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    const foreignAgentMembership = unwrapRight(
      MembershipFactory.newMembership({entity: createAgentMembershipEntity(foreignAgent)})
    )
    const localAgent = unwrapRight(AgentFactory.create({organizationId, agentName: "Local Agent"}))
    await prisma.agent.create({
      data: {
        id: localAgent.id,
        organizationId,
        agentName: localAgent.agentName,
        base64PublicKey: Buffer.from(localAgent.publicKey).toString("base64"),
        status: localAgent.status,
        roles: [],
        createdAt: localAgent.createdAt,
        updatedAt: localAgent.updatedAt,
        occ: 0n
      }
    })
    const localAgentMembership = unwrapRight(
      MembershipFactory.newMembership({entity: createAgentMembershipEntity(localAgent)})
    )

    const addResult = await transactionManager.execute(context, () =>
      membershipRepository.addMembershipsToGroup(context, {
        group: snapshot.group,
        memberships: [foreignMembership]
      })
    )()
    const agentAddResult = await transactionManager.execute(context, () =>
      membershipRepository.addMembershipsToGroup(context, {
        group: snapshot.group,
        memberships: [foreignAgentMembership]
      })
    )()
    const addedAgent = unwrapRight(
      await transactionManager.execute(context, () =>
        membershipRepository.addMembershipsToGroup(context, {
          group: snapshot.group,
          memberships: [localAgentMembership]
        })
      )()
    )
    const agentGroups = unwrapRight(
      await database.transactional(organizationId, () => repository.getGroupsByAgentId(context, localAgent.id)())
    )
    const agentMemberships = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.getAgentMembershipsByAgentId(context, localAgent.id)()
      )
    )
    const localAgentCount = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.countAgentMembersByGroupId(context, group.id)()
      )
    )
    const foreignAgentCount = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.countAgentMembersByGroupId(context, foreignGroup.id)()
      )
    )
    const foreignAgentGroups = unwrapRight(
      await database.transactional(organizationId, () => repository.getGroupsByAgentId(context, foreignAgent.id)())
    )
    const foreignAgentMemberships = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.getAgentMembershipsByAgentId(context, foreignAgent.id)()
      )
    )
    expect(localAgentCount).toBe(1)
    expect(foreignAgentCount).toBe(0)
    expect(foreignAgentGroups).toEqual([])
    expect(foreignAgentMemberships).toEqual([])
    const removedAgent = unwrapRight(
      await transactionManager.execute(context, () =>
        membershipRepository.removeMembershipFromGroup(context, {
          groupId: group.id,
          entityReferences: [{entityId: localAgent.id, entityType: "agent", organizationId}]
        })
      )()
    )
    const removeResult = await transactionManager.execute(context, () =>
      membershipRepository.removeMembershipFromGroup(context, {
        groupId: group.id,
        entityReferences: [{entityId: foreignUser.id, entityType: "user", organizationId: otherOrganizationId}]
      })
    )()
    const mixedRemove = await transactionManager.execute(context, () =>
      membershipRepository.removeMembershipFromGroup(context, {
        groupId: group.id,
        entityReferences: [
          {entityId: localUser.id, entityType: "user", organizationId},
          {entityId: foreignUser.id, entityType: "user", organizationId}
        ]
      })
    )()
    expect(mixedRemove).toBeLeftOf("membership_not_found")
    const membershipsByForeignUser = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.getUserMembershipsByUserId(context, foreignUser.id)()
      )
    )
    const localMemberCount = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.countUserMembersByGroupId(context, group.id)()
      )
    )

    const localMemberships = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.getUserMembershipsByUserId(context, localUser.id)()
      )
    )
    const localMemberInclude = await database.transactional(organizationId, () =>
      membershipRepository.getGroupWithMembershipById(context, {
        groupId: group.id,
        onlyIfMember: {userId: localUser.id}
      })()
    )
    const nonMemberInclude = await database.transactional(organizationId, () =>
      membershipRepository.getGroupWithMembershipById(context, {
        groupId: group.id,
        onlyIfMember: {userId: additionalUser.id}
      })()
    )
    expect(localMemberships.map(membership => membership.groupId)).toEqual([group.id])
    expect(localMemberships.map(membership => membership.getEntityId())).toEqual([localUser.id])
    expect(localMemberInclude).toBeRight()
    expect(nonMemberInclude).toBeLeftOf("group_not_found")
    expect(addResult).toBeLeftOf("membership_organization_mismatch")
    expect(agentAddResult).toBeLeftOf("membership_organization_mismatch")
    expect(addedAgent.memberships.map(membership => membership.getEntityId())).toContain(localAgent.id)
    expect(agentGroups.map(item => item.id)).toEqual([group.id])
    expect(agentMemberships.map(membership => membership.groupId)).toEqual([group.id])
    expect(removedAgent.memberships.map(membership => membership.getEntityId())).not.toContain(localAgent.id)
    expect(removeResult).toBeLeftOf("membership_organization_mismatch")
    expect(membershipsByForeignUser).toEqual([])
    expect(localMemberCount).toBe(1)
    await expect(prisma.groupMembership.count({where: {organizationId, groupId: group.id}})).resolves.toBe(1)
  })

  it("rolls back group and initial membership creation when the user version is stale", async () => {
    const context = {organizationId}
    const user = await createDomainMockUserInDb(prisma, {organizationId})
    const before = await prisma.user.findUniqueOrThrow({where: {id: user.id}})
    const group = unwrapRight(GroupFactory.newGroup({organizationId, name: "Rolled-back", description: null}))
    const membership = unwrapRight(MembershipFactory.newMembership({entity: createUserMembershipEntity(user)}))
    const result = await transactionManager.execute(context, () =>
      repository.createGroupWithMembershipAndUpdateUser(context, {
        group,
        user,
        userOcc: before.occ + 1n,
        membership
      })
    )()
    expect(result).toBeLeftOf("concurrency_error")
    expect(await prisma.group.count({where: {id: group.id}})).toBe(0)
    expect(await prisma.groupMembership.count({where: {groupId: group.id}})).toBe(0)
    expect(await prisma.user.findUniqueOrThrow({where: {id: user.id}})).toEqual(before)
  })

  it("allows only one concurrent membership update against the same group version", async () => {
    const context = {organizationId}
    const userA = unwrapRight(
      createTestUser({organizationId, accountId, displayName: "Owner", orgRole: OrgRole.MEMBER})
    )
    const accountB = uuidv7()
    const accountC = uuidv7()
    await Promise.all([
      prisma.platformAccount.create({data: account(accountB)}),
      prisma.platformAccount.create({data: account(accountC)})
    ])
    const userB = unwrapRight(
      createTestUser({organizationId, accountId: accountB, displayName: "Member B", orgRole: OrgRole.MEMBER})
    )
    const userC = unwrapRight(
      createTestUser({organizationId, accountId: accountC, displayName: "Member C", orgRole: OrgRole.MEMBER})
    )
    await Promise.all(
      [userA, userB, userC].map(user =>
        database.transactional(organizationId, () => repositoryUserCreate(database, user))
      )
    )

    const group = unwrapRight(GroupFactory.newGroup({organizationId, name: "Concurrent", description: null}))
    const initialMembership = unwrapRight(MembershipFactory.newMembership({entity: createUserMembershipEntity(userA)}))
    unwrapRight(
      await database.transactional(organizationId, () =>
        repository.createGroupWithMembershipAndUpdateUser(context, {
          group,
          user: userA,
          userOcc: 0n,
          membership: initialMembership
        })()
      )
    )
    const snapshot = unwrapRight(
      await database.transactional(organizationId, () =>
        membershipRepository.getGroupWithMembershipById(context, {groupId: group.id, onlyIfMember: false})()
      )
    )
    const membershipB = unwrapRight(MembershipFactory.newMembership({entity: createUserMembershipEntity(userB)}))
    const membershipC = unwrapRight(MembershipFactory.newMembership({entity: createUserMembershipEntity(userC)}))

    const results = await Promise.all([
      transactionManager.execute(context, () =>
        membershipRepository.addMembershipsToGroup(context, {group: snapshot.group, memberships: [membershipB]})
      )(),
      transactionManager.execute(context, () =>
        membershipRepository.addMembershipsToGroup(context, {group: snapshot.group, memberships: [membershipC]})
      )()
    ])

    expect(results.map(result => result._tag).sort()).toEqual(["Left", "Right"])
    const conflict = results.find(result => result._tag === "Left")
    expect(conflict?._tag === "Left" ? conflict.left : undefined).toBe("concurrent_modification_error")
    const stored = await prisma.group.findUnique({
      where: {organizationId_id: {organizationId, id: group.id}},
      include: {groupMemberships: true}
    })
    expect(stored?.occ).toBe(snapshot.group.occ + 1n)
    expect(stored?.groupMemberships).toHaveLength(2)
  })
})

async function repositoryUserCreate(database: DatabaseClient, user: User): Promise<void> {
  await new GroupTenantClient(database).cx.user.create({
    data: {
      id: user.id,
      organizationId: user.organizationId,
      platformAccountId: user.accountId,
      displayName: user.displayName,
      status: user.status,
      orgRole: user.orgRole,
      roles: [],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      occ: 0n
    }
  })
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

function account(id: string) {
  const now = new Date()
  return {
    id,
    displayName: "Account",
    profileEmail: "account@example.com",
    status: "active",
    createdAt: now,
    updatedAt: now,
    occ: 0n
  }
}
