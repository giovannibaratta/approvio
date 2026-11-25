import {randomOrgId} from "@test/organization-id"
import {AppModule} from "@app/app.module"
import {ConfigProvider} from "@external/config"
import {Controller, Get, HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test} from "@nestjs/testing"
import {PrismaClient} from "@prisma/client"
import request from "supertest"
import {createFixturePrismaClient, cleanDatabase, prepareDatabase} from "@test/database"
import {MockConfigProvider} from "@test/mock-data"
import {createAuthenticatedUserInDb} from "@test/token-helpers"
import * as TE from "fp-ts/TaskEither"
import {ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN, OrganizationDirectoryRepository} from "@services/tenancy/interfaces"

@Controller("o/:organizationId/admission-policy-test")
class AdmissionPolicyTestController {
  @Get("unmarked")
  unmarked(): {ok: boolean} {
    return {ok: true}
  }
}

describe("Tenant boundary", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let jwtService: JwtService
  let configProvider: ConfigProvider

  beforeAll(async () => {
    const isolatedDb = await prepareDatabase()
    const module = await Test.createTestingModule({imports: [AppModule], controllers: [AdmissionPolicyTestController]})
      .overrideProvider(ConfigProvider)
      .useValue(MockConfigProvider.fromTenantConnectionUrl(isolatedDb))
      .compile()

    app = module.createNestApplication({logger: false})
    prisma = createFixturePrismaClient(isolatedDb)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)
    await app.init()
  }, 30000)

  afterEach(async () => {
    jest.restoreAllMocks()
    if (prisma) await cleanDatabase(prisma)
  })

  afterAll(async () => {
    await prisma?.$disconnect()
    await app?.close()
  })

  it("rejects a valid local credential retargeted to another organization", async () => {
    // Given
    const first = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})
    const second = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {
      orgAdmin: true,
      organizationId: randomOrgId()
    })

    // When and Expect
    await request(app.getHttpServer())
      .get(`/o/${second.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${first.token}`)
      .expect(HttpStatus.FORBIDDEN)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_MISMATCH"))
  })

  it("rejects an organization route without a credential", async () => {
    // Given
    const organizationId = randomOrgId()

    // When
    const response = await request(app.getHttpServer()).get(`/o/${organizationId}/spaces`)

    // Expect
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED)
  })

  it("rejects resource access after suspension while allowing the owner's management summary", async () => {
    // Given
    const owner = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgRole: "owner"})
    await prisma.organization.update({
      where: {id: owner.user.organizationId},
      data: {status: "suspended", suspensionReason: "owner_requested"}
    })

    // When and Expect
    await request(app.getHttpServer())
      .get(`/o/${owner.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.LOCKED)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_SUSPENDED"))

    // When and Expect
    await request(app.getHttpServer())
      .get(`/o/${owner.user.organizationId}`)
      .set("Authorization", `Bearer ${owner.token}`)
      .expect(HttpStatus.OK)
  })

  it("admits an active tenant endpoint without admission metadata", async () => {
    // Given
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)

    // When
    const response = await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/admission-policy-test/unmarked`)
      .set("Authorization", `Bearer ${member.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.OK)
    expect(response.body).toEqual({ok: true})
  })

  it.each(["suspended", "deleting"] as const)(
    "rejects an undecorated tenant endpoint when the organization is %s",
    async status => {
      // Given
      const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
      await prisma.organization.update({
        where: {id: member.user.organizationId},
        data: status === "suspended" ? {status, suspensionReason: "owner_requested"} : {status}
      })

      // When
      const response = await request(app.getHttpServer())
        .get(`/o/${member.user.organizationId}/admission-policy-test/unmarked`)
        .set("Authorization", `Bearer ${member.token}`)

      // Expect
      expect(response.status).toBe(status === "suspended" ? HttpStatus.LOCKED : HttpStatus.NOT_FOUND)
      expect(response.body.code).toBe(status === "suspended" ? "ORGANIZATION_SUSPENDED" : "RESOURCE_NOT_FOUND")
    }
  )

  it("rejects a stale browser context with 409 before reaching a tenant handler", async () => {
    // Given
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    await prisma.browserSession.updateMany({
      where: {accountId: member.user.accountId},
      data: {contextVersion: {increment: 1}}
    })

    // When and Expect
    await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${member.token}`)
      .expect(HttpStatus.CONFLICT)
      .expect(({body}) => expect(body.code).toBe("ORGANIZATION_CONTEXT_CHANGED"))
  })

  it("rejects a committed membership removal without exposing tenant data", async () => {
    // Given
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    await prisma.user.update({where: {id: member.user.id}, data: {status: "removed", roles: []}})

    // When and Expect
    await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${member.token}`)
      .expect(HttpStatus.NOT_FOUND)
      .expect(({body}) => expect(body.code).toBe("USER_NOT_FOUND"))
  })

  it("rejects a committed browser session revocation", async () => {
    // Given
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    await prisma.browserSession.updateMany({where: {accountId: member.user.accountId}, data: {status: "revoked"}})

    // When
    const response = await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${member.token}`)

    // Expect
    expect(response.status).toBe(HttpStatus.UNAUTHORIZED)
  })

  it("fails closed when the admission storage lookup fails", async () => {
    // Given
    const member = await createAuthenticatedUserInDb(prisma, jwtService, configProvider)
    const directory = app.get<OrganizationDirectoryRepository>(ORGANIZATION_DIRECTORY_REPOSITORY_TOKEN)
    jest.spyOn(directory, "get").mockReturnValueOnce(TE.left("repository_dependency_error"))

    // When and Expect
    await request(app.getHttpServer())
      .get(`/o/${member.user.organizationId}/spaces`)
      .set("Authorization", `Bearer ${member.token}`)
      .expect(HttpStatus.SERVICE_UNAVAILABLE)
      .expect(({body}) => expect(body.code).toBe("UNKNOWN_ERROR"))
  })

  it("rejects malformed organization context for an authenticated request", async () => {
    // Given
    const user = await createAuthenticatedUserInDb(prisma, jwtService, configProvider, {orgAdmin: true})

    // When and Expect
    await request(app.getHttpServer())
      .get("/o/not-a-uuid/spaces")
      .set("Authorization", `Bearer ${user.token}`)
      .expect(HttpStatus.BAD_REQUEST)
      .expect(({body}) => expect(body.code).toBe("INVALID_ORGANIZATION"))
  })
})
