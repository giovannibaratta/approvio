import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {DatabaseClient, GroupDbRepository, UserDbRepository} from "@external"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createUserMembershipEntity, MembershipFactory} from "@domain"
import {createMockGroupDomain, createMockUserDomain, MockConfigProvider} from "@test/mock-data"
import "expect-more-jest"
import {unwrapRight} from "@utils/either"
import {getUserOcc} from "@test/occ"

describe("GroupDbRepository Integration", () => {
  let prisma: PrismaClient
  let repository: GroupDbRepository
  let userRepository: UserDbRepository

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GroupDbRepository,
        UserDbRepository,
        DatabaseClient,
        {
          provide: ConfigProvider,
          useValue: MockConfigProvider.fromDbConnectionUrl(isolatedDb)
        }
      ]
    }).compile()

    prisma = module.get(DatabaseClient)
    repository = module.get(GroupDbRepository)
    userRepository = module.get(UserDbRepository)
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
  })

  describe("createGroupWithMembershipAndUpdateUser", () => {
    it("should create a group and membership successfully", async () => {
      // Given
      const user = createMockUserDomain()
      const repoUser = unwrapRight(await userRepository.createUser(user)())
      const group = createMockGroupDomain()
      const membership = unwrapRight(
        MembershipFactory.newMembership({
          entity: createUserMembershipEntity(user)
        })
      )
      const userOcc = await getUserOcc(prisma, repoUser.id)

      // When
      const eitherResult = await repository.createGroupWithMembershipAndUpdateUser({
        group,
        user,
        userOcc,
        membership
      })()

      // Expect
      expect(eitherResult).toBeRight()
      const result = unwrapRight(eitherResult)
      expect(result.name).toBe(group.name)

      const dbGroup = await prisma.group.findUnique({where: {id: group.id}})
      expect(dbGroup).toBeDefined()
      expect(dbGroup?.name).toBe(group.name)

      const dbMembership = await prisma.groupMembership.findUnique({
        where: {
          groupId_userId: {
            groupId: group.id,
            userId: user.id
          }
        }
      })
      expect(dbMembership).toBeDefined()
    })

    it("should return group_already_exists when creating a group with a duplicate name", async () => {
      // Given
      const user = createMockUserDomain()
      const repoUser = unwrapRight(await userRepository.createUser(user)())
      const group = createMockGroupDomain()
      const membership = unwrapRight(
        MembershipFactory.newMembership({
          entity: createUserMembershipEntity(user)
        })
      )
      const userOcc = await getUserOcc(prisma, repoUser.id)

      await repository.createGroupWithMembershipAndUpdateUser({
        group,
        user,
        userOcc,
        membership
      })()

      const duplicateGroup = createMockGroupDomain({
        name: group.name
      })

      const newUserOcc = await getUserOcc(prisma, repoUser.id)

      // When
      const eitherResult = await repository.createGroupWithMembershipAndUpdateUser({
        group: duplicateGroup,
        user,
        userOcc: newUserOcc,
        membership
      })()

      // Expect
      expect(eitherResult).toBeLeftOf("group_already_exists")
    })

    it("should return user_not_found when creating a group with a non-existent user", async () => {
      // Given
      const user = createMockUserDomain()
      const group = createMockGroupDomain()
      const membership = unwrapRight(
        MembershipFactory.newMembership({
          entity: createUserMembershipEntity(user)
        })
      )

      // when
      const eitherResult = await repository.createGroupWithMembershipAndUpdateUser({
        group,
        user,
        userOcc: 0n, // It doesn't matter what value we provide here, it should fail for other reasons
        membership
      })()

      // Expect
      expect(eitherResult).toBeLeftOf("user_not_found")
    })
  })
})
