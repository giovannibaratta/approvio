import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import {
  createFixturePrismaClient,
  cleanDatabase,
  prepareDatabase,
  dropPreparedDatabase,
  prepareRedisPrefix,
  cleanRedisByPrefix
} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import {UserWithToken} from "@test/types"
import request from "supertest"

function spaceIdFromLocation(location: unknown): string {
  if (typeof location !== "string") throw new Error("Space creation response is missing its Location")
  const id = new URL(location).pathname.split("/").at(-1)
  if (!id) throw new Error("Space creation Location is missing its space ID")
  return id
}

describe("Space API tenant isolation", () => {
  let connection: string
  let redisPrefix: string
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let owner: UserWithToken
  let endpoint: string

  beforeAll(async () => {
    connection = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()
    const module = await Test.createTestingModule({imports: [AppModule]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(connection, redisPrefix))
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(connection)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    await app.init()
  }, 30000)

  beforeEach(async () => {
    owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "admin"})
    endpoint = `/o/${owner.user.organizationId}`
  })

  afterEach(async () => {
    await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await app.close()
    await prisma.$disconnect()
    await dropPreparedDatabase(connection)
    await cleanRedisByPrefix(redisPrefix)
  })

  it("creates and resolves the same space name independently in different organizations", async () => {
    // Given
    const other = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "admin"})
    const foreignEndpoint = `/o/${other.user.organizationId}/spaces`

    // When
    const first = await request(app.getHttpServer())
      .post(`${endpoint}/spaces`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({name: "Shared"})
      .expect(HttpStatus.CREATED)
    const second = await request(app.getHttpServer())
      .post(foreignEndpoint)
      .set("Authorization", `Bearer ${other.token}`)
      .send({name: "Shared"})
      .expect(HttpStatus.CREATED)
    const firstId = spaceIdFromLocation(first.headers.location)
    const secondId = spaceIdFromLocation(second.headers.location)

    const own = await request(app.getHttpServer())
      .get(`${endpoint}/spaces/${firstId}`)
      .set("Authorization", `Bearer ${owner.token}`)
    const foreign = await request(app.getHttpServer())
      .get(`${foreignEndpoint}/${secondId}`)
      .set("Authorization", `Bearer ${other.token}`)
    const stored = await prisma.space.findMany({where: {name: "Shared"}})

    // Expect
    expect(firstId).not.toBe(secondId)
    expect(stored).toHaveLength(2)
    expect(stored).toEqual(
      expect.arrayContaining([
        expect.objectContaining({id: firstId, organizationId: owner.user.organizationId, name: "Shared"}),
        expect.objectContaining({id: secondId, organizationId: other.user.organizationId, name: "Shared"})
      ])
    )
    expect(own.status).toBe(HttpStatus.OK)
    expect(own.body).toMatchObject({id: firstId, name: "Shared"})

    expect(foreign.status).toBe(HttpStatus.OK)
    expect(foreign.body).toMatchObject({id: secondId, name: "Shared"})
  })

  it("lists only local spaces even when another organization has the same names", async () => {
    // Given
    const other = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "admin"})
    const local = await request(app.getHttpServer())
      .post(`${endpoint}/spaces`)
      .set("Authorization", `Bearer ${owner.token}`)
      .send({name: "Shared"})
      .expect(HttpStatus.CREATED)
    const foreign = await request(app.getHttpServer())
      .post(`/o/${other.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${other.token}`)
      .send({name: "Shared"})
      .expect(HttpStatus.CREATED)
    const localId = spaceIdFromLocation(local.headers.location)
    const foreignId = spaceIdFromLocation(foreign.headers.location)

    // When
    const response = await request(app.getHttpServer())
      .get(`${endpoint}/spaces?search=Shared`)
      .set("Authorization", `Bearer ${owner.token}`)
    const foreignResponse = await request(app.getHttpServer())
      .get(`/o/${other.user.organizationId}/spaces?search=Shared`)
      .set("Authorization", `Bearer ${other.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body.data).toEqual([expect.objectContaining({id: localId, name: "Shared"})])
    expect(response.body.pagination.total).toBe(1)
    expect(foreignResponse.status).toBe(HttpStatus.OK)
    expect(foreignResponse.body.data).toEqual([expect.objectContaining({id: foreignId, name: "Shared"})])
    expect(foreignResponse.body.pagination.total).toBe(1)
  })

  it.each(["get", "delete"] as const)(
    "does not %s a foreign space through the local organization route",
    async method => {
      // Given
      const other = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "admin"})
      const created = await request(app.getHttpServer())
        .post(`/o/${other.user.organizationId}/spaces`)
        .set("Authorization", `Bearer ${other.token}`)
        .send({name: "Foreign"})
        .expect(HttpStatus.CREATED)
      const foreignId = spaceIdFromLocation(created.headers.location)

      // When
      const response = await request(app.getHttpServer())
        [method](`${endpoint}/spaces/${foreignId}`)
        .set("Authorization", `Bearer ${owner.token}`)

      // Expect
      expect(response.status).toBe(HttpStatus.NOT_FOUND)
      expect(response.body.code).toBe("SPACE_NOT_FOUND")
      expect(await prisma.space.findUniqueOrThrow({where: {id: foreignId}})).toMatchObject({
        organizationId: other.user.organizationId,
        name: "Foreign"
      })
    }
  )
})
