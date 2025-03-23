import * as request from "supertest"

import {cleanDatabase, prepareDatabase} from "../database"
import {Test, TestingModule} from "@nestjs/testing"
import {Config} from "@external/config"
import {NestApplication} from "@nestjs/core"
import {AppModule} from "@app/app.module"
import {DatabaseClient} from "@external"
import {GROUPS_ENDPOINT_ROOT} from "@controllers"
import {PrismaClient} from "@prisma/client"
import {GroupCreate} from "@api"

describe("POST /groups", () => {
  let app: NestApplication
  let prisma: PrismaClient
  const endpoint = `/${GROUPS_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()

    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    })
      .overrideProvider(Config)
      .useValue({
        getDbConnectionUrl: () => isolatedDb
      })
      .compile()

    app = module.createNestApplication()
    await app.init()

    prisma = module.get(DatabaseClient)
    await cleanDatabase(prisma)
  })

  describe("good cases", () => {
    it("should create a record in the database and return the uuid", async () => {
      // Given
      const requestBody: GroupCreate = {
        name: "This-is-a-group"
      }

      // When
      const response = await request(app.getHttpServer())
        .post(endpoint)
        .send(requestBody)

      // Expect

      // Validate response
      expect(response.headers.location).toBeDefined()

      const responseUuid: string =
        response.headers.location?.split("/").reverse()[0] ?? ""

      expect(response.status).toBe(201)

      // Validate side effects
      const planDbObject = await prisma.group.findUnique({
        where: {
          id: responseUuid
        }
      })
      expect(planDbObject).toBeDefined()
      expect(planDbObject?.name).toEqual(requestBody.name)
    })
  })

  describe("bad cases", () => {
    it("should throw NAME_ALREADY_IN_USE if there is already a group with the same name", async () => {
      // Given
      const requestBody: GroupCreate = {
        name: "This-is-a-group"
      }

      // When
      await request(app.getHttpServer())
        .post(endpoint)
        .send(requestBody)

      const response = await request(app.getHttpServer())
        .post(endpoint)
        .send(requestBody)

      // Expect
      expect(response.status).toBe(400)
      expect(response.body).toHaveErrorCode("GROUP_ALREADY_EXISTS")
    })
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
  })
})
