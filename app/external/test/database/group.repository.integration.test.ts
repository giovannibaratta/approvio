import {createUserMembershipEntity, MembershipFactory, UserFactory} from "@domain"
import {ConfigProvider} from "@external/config"
import {DATABASE_RUNTIME_ROLE_TOKEN, DatabaseClient} from "@external/database/database-client"
import {GroupMembershipDbRepository} from "@external/database/group-membership.repository"
import {GroupDbRepository} from "@external/database/group.repository"
import {
  GroupMembershipTenantClient,
  GroupTenantClient,
  UserTenantClient
} from "@external/database/tenant-database-clients"
import {UserDbRepository} from "@external/database/user.repository"
import {PrismaTransactionManager} from "@external/database/transaction-manager"
import {Test, TestingModule} from "@nestjs/testing"
import {Group, PrismaClient} from "@prisma/client"
import {cleanDatabase, createFixturePrismaClient, dropPreparedDatabase, prepareDatabase} from "@test/database"
import {
  createDomainMockUserInDb,
  createMockAccountDomain,
  createMockGroupDomain,
  createMockUserDomain
} from "@test/mock-data"
import {seedTwoOrganizationFixture, TwoOrganizationFixture} from "@test/tenancy"
import {getUserOcc} from "@test/occ"
import {unwrapRight} from "@utils/either"
import "@utils/matchers"

describe("GroupDbRepository Integration", () => {
  let connection: string
  let prisma: PrismaClient
  let module: TestingModule
  let accountId: string
  let userRepository: UserDbRepository
  let repository: GroupDbRepository
  let memberships: GroupMembershipDbRepository
  let transactions: PrismaTransactionManager
  let fixture: TwoOrganizationFixture
  let localGroup: Group
  let foreignGroup: Group

  beforeAll(async () => {
    connection = await prepareDatabase()
    prisma = createFixturePrismaClient(connection)
    module = await Test.createTestingModule({
      providers: [
        DatabaseClient,
        GroupTenantClient,
        UserTenantClient,
        UserDbRepository,
        GroupMembershipTenantClient,
        GroupDbRepository,
        GroupMembershipDbRepository,
        PrismaTransactionManager,
        {provide: DATABASE_RUNTIME_ROLE_TOKEN, useValue: "approvio_tenant_runtime"},
        {
          provide: ConfigProvider,
          useValue: {
            databaseConfig: {
              tenantConnectionUrl: connection,
              platformConnectionUrl: connection,
              retry: {maxAttempts: 1, initialDelayMs: 0, backoffFactor: 1, maxDelayMs: 0}
            }
          }
        }
      ]
    }).compile()
    userRepository = module.get(UserDbRepository)
    repository = module.get(GroupDbRepository)
    memberships = module.get(GroupMembershipDbRepository)
    transactions = module.get(PrismaTransactionManager)
    await module.init()
  }, 30_000)

  beforeEach(async () => {
    fixture = await seedTwoOrganizationFixture(prisma)
    const account = createMockAccountDomain()
    await prisma.platformAccount.create({data: {...account, occ: 0n}})
    accountId = account.id
    localGroup = await prisma.group.findUniqueOrThrow({
      where: {organizationId_name: {organizationId: fixture.organizationA.id, name: "shared-name"}}
    })
    foreignGroup = await prisma.group.findUniqueOrThrow({
      where: {organizationId_name: {organizationId: fixture.organizationB.id, name: "shared-name"}}
    })
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await module.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
  })

  describe("createGroupWithMembershipAndUpdateUser", () => {
    it("should create a group and membership successfully", async () => {
      // Given
      const context = {organizationId: fixture.organizationA.id}
      const user = createMockUserDomain({...context, accountId})
      const repoUser = unwrapRight(await transactions.execute(context, () => userRepository.createUser(user))())
      const group = createMockGroupDomain(context)
      const membership = unwrapRight(
        MembershipFactory.newMembership({
          entity: createUserMembershipEntity(user)
        })
      )
      const userOcc = await getUserOcc(prisma, repoUser.id)

      // When
      const eitherResult = await transactions.execute(context, () =>
        repository.createGroupWithMembershipAndUpdateUser(context, {
          group,
          user,
          userOcc,
          membership
        })
      )()

      // Expect
      expect(eitherResult).toBeRight()
      const result = unwrapRight(eitherResult)
      expect(result.name).toBe(group.name)

      const dbGroup = await prisma.group.findUnique({where: {id: group.id}})
      expect(dbGroup).toBeDefined()
      expect(dbGroup?.name).toBe(group.name)

      const dbMembership = await prisma.groupMembership.findUnique({
        where: {
          organizationId_groupId_userId: {
            ...context,
            groupId: group.id,
            userId: user.id
          }
        }
      })
      expect(dbMembership).toBeDefined()
    })

    it("should return group_already_exists when creating a group with a duplicate name", async () => {
      // Given
      const context = {organizationId: fixture.organizationA.id}
      const user = createMockUserDomain({...context, accountId})
      const repoUser = unwrapRight(await transactions.execute(context, () => userRepository.createUser(user))())
      const group = createMockGroupDomain(context)
      const membership = unwrapRight(
        MembershipFactory.newMembership({
          entity: createUserMembershipEntity(user)
        })
      )
      const userOcc = await getUserOcc(prisma, repoUser.id)

      await transactions.execute(context, () =>
        repository.createGroupWithMembershipAndUpdateUser(context, {
          group,
          user,
          userOcc,
          membership
        })
      )()

      const duplicateGroup = createMockGroupDomain({
        ...context,
        name: group.name
      })

      const newUserOcc = await getUserOcc(prisma, repoUser.id)

      // When
      const eitherResult = await transactions.execute(context, () =>
        repository.createGroupWithMembershipAndUpdateUser(context, {
          group: duplicateGroup,
          user,
          userOcc: newUserOcc,
          membership
        })
      )()

      // Expect
      expect(eitherResult).toBeLeftOf("group_already_exists")
    })

    it("should return user_not_found when creating a group with a non-existent user", async () => {
      // Given
      const context = {organizationId: fixture.organizationA.id}
      const user = createMockUserDomain({...context, accountId})
      const group = createMockGroupDomain(context)
      const membership = unwrapRight(
        MembershipFactory.newMembership({
          entity: createUserMembershipEntity(user)
        })
      )

      // when
      const eitherResult = await transactions.execute(context, () =>
        repository.createGroupWithMembershipAndUpdateUser(context, {
          group,
          user,
          userOcc: 0n, // It doesn't matter what value we provide here, it should fail for other reasons
          membership
        })
      )()

      // Expect
      expect(eitherResult).toBeLeftOf("user_not_found")
    })
  })

  it("resolves a shared group name within the current organization", async () => {
    // Given
    const context = {organizationId: fixture.organizationA.id}

    // When
    const result = await transactions.execute(context, () =>
      repository.getGroupByName(context, {groupName: foreignGroup.name})
    )()

    // Expect
    expect(unwrapRight(result).id).toBe(localGroup.id)
  })

  it("hides foreign groups from individual and bulk reads", async () => {
    // Given
    const context = {organizationId: fixture.organizationA.id}

    // When
    const fetched = await transactions.execute(context, () =>
      repository.getGroupById(context, {groupId: foreignGroup.id})
    )()
    const bulk = await transactions.execute(context, () =>
      repository.getGroupsByIds(context, [localGroup.id, foreignGroup.id])
    )()
    const withMemberships = await transactions.execute(context, () =>
      memberships.getGroupWithMembershipById(context, {groupId: foreignGroup.id, onlyIfMember: false})
    )()

    // Expect
    expect(fetched).toBeLeftOf("group_not_found")
    expect(bulk).toBeRightOf([{id: localGroup.id, name: localGroup.name}])
    expect(withMemberships).toBeLeftOf("group_not_found")
  })

  it("excludes foreign groups from lists and counts", async () => {
    // Given
    const context = {organizationId: fixture.organizationA.id}

    // When
    const listed = await transactions.execute(context, () =>
      repository.listGroups(context, {filter: {type: "all"}, page: 1, limit: 10})
    )()
    const count = await transactions.execute(context, () => repository.countGroups(context))()

    // Expect
    const result = unwrapRight(listed)
    expect(result.groups.map(group => group.id)).toEqual([localGroup.id])
    expect(result.total).toBe(1)
    expect(count).toBeRightOf(1)
  })

  it("hides another organization's user and agent memberships", async () => {
    // Given
    const context = {organizationId: fixture.organizationA.id}
    const foreign = fixture.organizationB
    const now = new Date()
    await prisma.groupMembership.create({
      data: {
        organizationId: foreign.id,
        groupId: foreignGroup.id,
        userId: foreign.userId,
        createdAt: now,
        updatedAt: now
      }
    })
    await prisma.agentGroupMembership.create({
      data: {
        organizationId: foreign.id,
        groupId: foreignGroup.id,
        agentId: foreign.agentId,
        createdAt: now,
        updatedAt: now
      }
    })

    // When
    const userGroups = await transactions.execute(context, () =>
      repository.getGroupsByUserId(context, foreign.userId)
    )()
    const agentGroups = await transactions.execute(context, () =>
      repository.getGroupsByAgentId(context, foreign.agentId)
    )()
    const userMemberships = await transactions.execute(context, () =>
      memberships.getUserMembershipsByUserId(context, foreign.userId)
    )()
    const agentMemberships = await transactions.execute(context, () =>
      memberships.getAgentMembershipsByAgentId(context, foreign.agentId)
    )()
    const userCount = await transactions.execute(context, () =>
      memberships.countUserMembersByGroupId(context, foreignGroup.id)
    )()
    const agentCount = await transactions.execute(context, () =>
      memberships.countAgentMembersByGroupId(context, foreignGroup.id)
    )()

    // Expect
    expect(userGroups).toBeRightOf([])
    expect(agentGroups).toBeRightOf([])
    expect(userMemberships).toBeRightOf([])
    expect(agentMemberships).toBeRightOf([])
    expect(userCount).toBeRightOf(0)
    expect(agentCount).toBeRightOf(0)
  })

  it("rejects a foreign user reference even when its organization ID is forged", async () => {
    // Given
    const context = {organizationId: fixture.organizationA.id}
    const foreignUser = await createDomainMockUserInDb(prisma, {organizationId: fixture.organizationB.id})
    const forgedUser = unwrapRight(UserFactory.validate({...foreignUser, ...context}))
    const membership = unwrapRight(MembershipFactory.newMembership({entity: createUserMembershipEntity(forgedUser)}))
    const {group} = unwrapRight(
      await transactions.execute(context, () =>
        memberships.getGroupWithMembershipById(context, {groupId: localGroup.id, onlyIfMember: false})
      )()
    )

    // When
    const result = await transactions.execute(context, () =>
      memberships.addMembershipsToGroup(context, {group, memberships: [membership]})
    )()

    // Expect
    expect(result).toBeLeftOf("membership_user_not_found")
    expect(await prisma.groupMembership.count({where: {groupId: localGroup.id, userId: foreignUser.id}})).toBe(0)
  })
})
