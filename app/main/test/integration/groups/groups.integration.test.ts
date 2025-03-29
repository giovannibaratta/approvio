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
import {randomUUID} from "crypto"
import {Group as PrismaGroup} from "@prisma/client"

async function createTestGroup(prisma: PrismaClient, name: string, description?: string): Promise<PrismaGroup> {
  const group = await prisma.group.create({
    data: {
      id: randomUUID(),
      name: name,
      description: description,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  })
  return group
}

describe("Groups API", () => {
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

  afterEach(async () => {
    await prisma.$disconnect()
    await app.close()
  })

  describe(`POST ${endpoint}`, () => {
    describe("good cases", () => {
      it("should create a record in the database and return 201 with location header", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "This-is-a-group",
          description: "A test description"
        }

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response.status).toBe(201)
        expect(response.headers.location).toMatch(new RegExp(`${endpoint}/[a-f0-9-]+`))

        const responseUuid: string = response.headers.location?.split("/").reverse()[0] ?? ""

        // Validate side effects
        const groupDbObject = await prisma.group.findUnique({
          where: {
            id: responseUuid
          }
        })
        expect(groupDbObject).toBeDefined()
        expect(groupDbObject?.name).toEqual(requestBody.name)
        expect(groupDbObject?.description).toEqual(requestBody.description)
      })
    })

    describe("bad cases", () => {
      it("should throw 400 BAD_REQUEST (GROUP_ALREADY_EXISTS) if a group with the same name exists", async () => {
        // Given
        const requestBody: GroupCreate = {
          name: "Duplicate Group Name"
        }
        await createTestGroup(prisma, requestBody.name)

        // When
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        // Expect
        expect(response.status).toBe(400)
        expect(response.body).toHaveErrorCode("GROUP_ALREADY_EXISTS")
      })

      it("should throw 400 BAD_REQUEST (NAME_EMPTY) if name is empty", async () => {
        const requestBody: GroupCreate = {
          name: ""
        }
        const response = await request(app.getHttpServer()).post(endpoint).send(requestBody)

        expect(response.status).toBe(400)
        expect(response.body).toHaveErrorCode("NAME_EMPTY")
      })
    })
  })

  describe(`GET ${endpoint}`, () => {
    describe("good cases", () => {
      it("should return an empty list and default pagination when no groups exist", async () => {
        // When
        const response = await request(app.getHttpServer()).get(endpoint)

        // Expect
        expect(response.status).toBe(200)
        expect(response.body.groups).toEqual([])
        expect(response.body.pagination).toEqual({
          total: 0,
          page: 1,
          limit: 20
        })
      })

      it("should return a list of groups with correct pagination", async () => {
        // Given: some groups
        await createTestGroup(prisma, "Group 1")
        await createTestGroup(prisma, "Group 2")
        await createTestGroup(prisma, "Group 3")

        // When: Request the first page with limit 2
        const response = await request(app.getHttpServer()).get(`${endpoint}?page=1&limit=2`)

        // Expect
        expect(response.status).toBe(200)
        expect(response.body.groups).toHaveLength(2)
        expect(response.body.pagination).toEqual({
          total: 3,
          page: 1,
          limit: 2
        })

        // When: Request the second page
        const responsePage2 = await request(app.getHttpServer()).get(`${endpoint}?page=2&limit=2`)

        // Expect page 2
        expect(responsePage2.status).toBe(200)
        expect(responsePage2.body.groups).toHaveLength(1)
        expect(responsePage2.body.pagination).toEqual({
          total: 3,
          page: 2,
          limit: 2
        })
      })
    })
  })

  describe(`GET ${endpoint}/:groupId`, () => {
    describe("good cases", () => {
      it("should return the details of a specific group", async () => {
        // Given
        const createdGroup = await createTestGroup(prisma, "Specific Group", "Details here")

        // When
        const response = await request(app.getHttpServer()).get(`${endpoint}/${createdGroup.id}`)

        // Expect
        expect(response.status).toBe(200)
        expect(response.body.id).toEqual(createdGroup.id)
        expect(response.body.name).toEqual(createdGroup.name)
        expect(response.body.description).toEqual(createdGroup.description)
        expect(response.body.createdAt).toBeDefined()
        expect(response.body.updatedAt).toBeDefined()
      })
    })
  })
})
