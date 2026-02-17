import {Test, TestingModule} from "@nestjs/testing"
import {ConfigProvider} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {USERS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"
import {cleanDatabase, prepareDatabase} from "@test/database"
import {createDomainMockUserInDb, MockConfigProvider} from "@test/mock-data"
import {HttpStatus} from "@nestjs/common"
import {JwtService} from "@nestjs/jwt"
import {get} from "@test/requests"
import {UserWithToken} from "@test/types"
import "expect-more-jest"
import "@utils/matchers"
import {TokenPayloadBuilder} from "@services"

describe("User Enumeration Security Check", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let orgMemberUser: UserWithToken

  const endpoint = `/${USERS_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication({logger: ["error", "warn"]})
    prisma = module.get(DatabaseClient)
    const jwtService = module.get(JwtService)
    const configProvider = module.get(ConfigProvider)

    const memberUser = await createDomainMockUserInDb(prisma, {orgAdmin: false})

    const memberTokenPayload = TokenPayloadBuilder.fromUser(memberUser, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    orgMemberUser = {user: memberUser, token: jwtService.sign(memberTokenPayload)}

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await app.close()
  })

  it("should prevent non-admin users from listing users (user enumeration)", async () => {
    // When
    const response = await get(app, endpoint).withToken(orgMemberUser.token).build()

    // Expect
    // This is expected to fail currently (it returns 200 OK)
    // After the fix, it should return 403 Forbidden
    expect(response).toHaveStatusCode(HttpStatus.FORBIDDEN)
    expect(response.body).toHaveErrorCode("REQUESTOR_NOT_AUTHORIZED")
  })
})
