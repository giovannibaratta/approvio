import {CanVoteResponse as CanVoteResponseApi, WorkflowVoteRequest as WorkflowVoteRequestApi} from "@approvio/api"
import {AppModule} from "@app/app.module"
import {WORKFLOWS_ENDPOINT_ROOT} from "@controllers"
import {SystemRole} from "@domain"
import {ApprovalRuleType, WorkflowStatus} from "@domain"
import {DatabaseClient} from "@external"
import {ConfigProvider} from "@external/config"
import {HttpStatus} from "@nestjs/common"
import {NestApplication} from "@nestjs/core"
import {JwtService} from "@nestjs/jwt"
import {Test, TestingModule} from "@nestjs/testing"
import {
  PrismaClient,
  Workflow as PrismaWorkflow,
  WorkflowTemplate as PrismaWorkflowTemplate,
  Agent as PrismaAgent
} from "@prisma/client"
import {randomUUID} from "crypto"
import {cleanDatabase, prepareDatabase, prepareRedisPrefix, cleanRedisByPrefix} from "@test/database"
import {
  createMockAgentInDb,
  createMockWorkflowInDb,
  createMockWorkflowTemplateInDb,
  createTestGroup,
  MockConfigProvider
} from "@test/mock-data"
import {get, post} from "@test/requests"
import {TokenPayloadBuilder} from "@services"
import {mapAgentToDomain} from "@external/database/shared"
import {isLeft} from "fp-ts/lib/Either"
import {getQueueToken} from "@nestjs/bull"
import {WORKFLOW_STATUS_RECALCULATION_QUEUE} from "@external"
import {Queue} from "bull"

type AgentWithToken = {
  agent: PrismaAgent
  token: string
}

async function addAgentToGroup(prisma: PrismaClient, groupId: string, agentId: string): Promise<void> {
  await prisma.agentGroupMembership.upsert({
    where: {
      groupId_agentId: {
        groupId: groupId,
        agentId: agentId
      }
    },
    update: {
      updatedAt: new Date()
    },
    create: {
      groupId: groupId,
      agentId: agentId,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  })
}

describe("Agent Workflow Voting API", () => {
  let app: NestApplication
  let prisma: PrismaClient
  let testAgent: AgentWithToken
  let testAgentNotInGroup: AgentWithToken
  let testAgentWithRole: AgentWithToken
  let jwtService: JwtService
  let configProvider: ConfigProvider
  let mockGroupId: string
  let mockWorkflowTemplate: PrismaWorkflowTemplate
  let redisPrefix: string
  let recalculationQueue: Queue

  const endpoint = `/${WORKFLOWS_ENDPOINT_ROOT}`

  beforeEach(async () => {
    const isolatedDb = await prepareDatabase()
    redisPrefix = prepareRedisPrefix()

    let module: TestingModule
    try {
      module = await Test.createTestingModule({
        imports: [AppModule]
      })
        .overrideProvider(ConfigProvider)
        .useValue(MockConfigProvider.fromDbConnectionUrl(isolatedDb, redisPrefix))
        .compile()
    } catch (error) {
      console.error(error)
      throw error
    }

    app = module.createNestApplication({logger: ["error", "warn"]})

    prisma = module.get(DatabaseClient)
    jwtService = module.get(JwtService)
    configProvider = module.get(ConfigProvider)

    const testGroup = await createTestGroup(prisma, {name: "Test-Agent-Voter-Group"})
    mockGroupId = testGroup.id

    mockWorkflowTemplate = await createMockWorkflowTemplateInDb(prisma, {
      approvalRule: {
        type: ApprovalRuleType.GROUP_REQUIREMENT,
        groupId: mockGroupId,
        minCount: 2
      }
    })

    // Create agents for testing
    const agent = await createMockAgentInDb(prisma, {agentName: "test-voting-agent"})
    const agentNotInGroup = await createMockAgentInDb(prisma, {agentName: "test-agent-no-group"})
    const agentWithRole = await createMockAgentInDb(prisma, {agentName: "test-agent-with-role"})

    // Map agents to domain objects
    const domainAgent = mapAgentToDomain(agent)
    const domainAgentNotInGroup = mapAgentToDomain(agentNotInGroup)
    const domainAgentWithRole = mapAgentToDomain(agentWithRole)

    if (isLeft(domainAgent) || isLeft(domainAgentNotInGroup) || isLeft(domainAgentWithRole)) {
      throw new Error("Failed to initialize agent mocks")
    }

    // Add voter roles for agents (preparing for future schema support)
    const voterRole = SystemRole.createWorkflowTemplateVoterRole({
      type: "workflow_template",
      workflowTemplateId: mockWorkflowTemplate.id
    })
    const roleForDb = JSON.parse(JSON.stringify(voterRole))

    // Assign voter roles to agents
    await prisma.agent.update({
      where: {id: agent.id},
      data: {roles: [roleForDb]}
    })
    await prisma.agent.update({
      where: {id: agentNotInGroup.id},
      data: {roles: [roleForDb]}
    })
    await prisma.agent.update({
      where: {id: agentWithRole.id},
      data: {roles: [roleForDb]}
    })

    // Add agents to group (except agentNotInGroup)
    await addAgentToGroup(prisma, mockGroupId, agent.id)
    await addAgentToGroup(prisma, mockGroupId, agentWithRole.id)

    // Create agent token payloads
    const agentTokenPayload = TokenPayloadBuilder.fromAgent(domainAgent.right, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })
    const agentNotInGroupTokenPayload = TokenPayloadBuilder.fromAgent(domainAgentNotInGroup.right, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })
    const agentWithRoleTokenPayload = TokenPayloadBuilder.fromAgent(domainAgentWithRole.right, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })

    testAgent = {agent, token: jwtService.sign(agentTokenPayload)}
    testAgentNotInGroup = {agent: agentNotInGroup, token: jwtService.sign(agentNotInGroupTokenPayload)}
    testAgentWithRole = {agent: agentWithRole, token: jwtService.sign(agentWithRoleTokenPayload)}

    recalculationQueue = module.get<Queue>(getQueueToken(WORKFLOW_STATUS_RECALCULATION_QUEUE))

    await app.init()
  }, 30000)

  afterEach(async () => {
    await cleanDatabase(prisma)
    await prisma.$disconnect()
    await cleanRedisByPrefix(redisPrefix)
    await app.close()
  })

  it("should be defined", () => {
    expect(app).toBeDefined()
    expect(recalculationQueue).toBeDefined()
  })

  describe("GET /workflows/:workflowId/canVote", () => {
    let testWorkflow: PrismaWorkflow

    beforeEach(async () => {
      testWorkflow = await createMockWorkflowInDb(prisma, {
        name: "Agent-Can-Vote-Workflow",
        description: "Workflow for testing agent voting eligibility",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        workflowTemplateId: mockWorkflowTemplate.id
      })
    })

    describe("good cases - expected future behavior when agent voting is properly implemented", () => {
      it("should return 200 OK with canVote:true for agent with voter role and in required group", async () => {
        // When: agent with proper permissions attempts to check voting eligibility
        const response = await get(app, `${endpoint}/${testWorkflow.id}/canVote`).withToken(testAgent.token).build()

        // Expect: agent should be able to vote when properly configured
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(true)
        expect(body.voteStatus).toEqual("VOTE_PENDING")
        expect(body.cantVoteReason).toBeUndefined()
      })

      it("should return 200 OK with canVote:true for another agent with voter role and in required group", async () => {
        // When: agent with voter role and group membership checks voting eligibility
        const response = await get(app, `${endpoint}/${testWorkflow.id}/canVote`)
          .withToken(testAgentWithRole.token)
          .build()

        // Expect: agent should be able to vote when in required group with proper role
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(true)
        expect(body.voteStatus).toEqual("VOTE_PENDING")
        expect(body.cantVoteReason).toBeUndefined()
      })

      it("should return 200 OK with canVote:false for agent not in required group", async () => {
        // When: agent not in group attempts to check voting eligibility
        const response = await get(app, `${endpoint}/${testWorkflow.id}/canVote`)
          .withToken(testAgentNotInGroup.token)
          .build()

        // Expect: agent should get canVote:false due to missing group membership
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(false)
        expect(body.cantVoteReason).toEqual("ENTITY_NOT_IN_GROUP")
      })

      it("should return 200 OK with canVote:false for expired workflows", async () => {
        // Given: a workflow with an expired date
        const expiredWorkflow = await createMockWorkflowInDb(prisma, {
          name: "Expired-Agent-Workflow",
          status: WorkflowStatus.EVALUATION_IN_PROGRESS,
          workflowTemplateId: mockWorkflowTemplate.id,
          expiresAt: new Date(Date.now() - 1000)
        })

        // When: agent attempts to check voting eligibility on expired workflow
        const response = await get(app, `${endpoint}/${expiredWorkflow.id}/canVote`).withToken(testAgent.token).build()

        // Expect: agent should get canVote:false due to workflow expiration
        expect(response).toHaveStatusCode(HttpStatus.OK)
        const body: CanVoteResponseApi = response.body
        expect(body.canVote).toBe(false)
        expect(body.cantVoteReason).toEqual("WORKFLOW_EXPIRED")
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // When: request is sent without a token
        const response = await get(app, `${endpoint}/${testWorkflow.id}/canVote`).build()

        // Expect: unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 400 BAD_REQUEST for non-existent workflow", async () => {
        // Given: non-existent workflow ID
        const nonExistentWorkflowId = randomUUID()

        // When: agent checks voting eligibility for non-existent workflow
        const response = await get(app, `${endpoint}/${nonExistentWorkflowId}/canVote`)
          .withToken(testAgent.token)
          .build()

        // Expect: workflow not found error
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })
    })
  })

  describe("POST /workflows/:workflowId/vote", () => {
    let workflowForVoting: PrismaWorkflow

    beforeEach(async () => {
      workflowForVoting = await createMockWorkflowInDb(prisma, {
        name: "Agent-Voting-Workflow",
        description: "Workflow for testing agent voting",
        status: WorkflowStatus.EVALUATION_IN_PROGRESS,
        workflowTemplateId: mockWorkflowTemplate.id,
        expiresAt: "active"
      })
    })

    describe("good cases", () => {
      it("should allow agent with proper permissions to APPROVE a workflow and return 202 ACCEPTED", async () => {
        // Given: vote request to approve workflow
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId]
          }
        }

        // When: agent with proper permissions attempts to vote
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        // Expect: vote should be accepted and recorded in the database
        expect(response).toHaveStatusCode(HttpStatus.ACCEPTED)
        const voteInDb = await prisma.vote.findFirst({
          where: {workflowId: workflowForVoting.id, agentId: testAgent.agent.id}
        })

        expect(voteInDb).toBeDefined()
        expect(voteInDb?.voteType).toEqual("APPROVE")
      })

      it("should allow agent with proper permissions to VETO a workflow and return 202 ACCEPTED", async () => {
        // Given: vote request to veto workflow
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {type: "VETO"},
          reason: "Agent detected security issue"
        }

        // When: agent with proper permissions attempts to vote
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        // Expect: veto vote should be accepted and recorded
        expect(response).toHaveStatusCode(HttpStatus.ACCEPTED)
        const voteInDb = await prisma.vote.findFirst({
          where: {workflowId: workflowForVoting.id, agentId: testAgent.agent.id}
        })
        expect(voteInDb).toBeDefined()
        expect(voteInDb?.voteType).toEqual("VETO")
        expect(voteInDb?.reason).toEqual("Agent detected security issue")
      })

      it("should be possible for agent to vote multiple times", async () => {
        // Given: vote request to approve workflow
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId]
          }
        }

        // When: agent sends multiple vote requests
        const response1 = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        expect(response1).toHaveStatusCode(HttpStatus.ACCEPTED)

        const response2 = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        // Expect: multiple votes should be recorded in the database
        expect(response2).toHaveStatusCode(HttpStatus.ACCEPTED)
        const votesInDb = await prisma.vote.findMany({
          where: {workflowId: workflowForVoting.id, agentId: testAgent.agent.id}
        })
        expect(votesInDb).toHaveLength(2)
      })

      it("should allow create a recalculation task if vote is successful", async () => {
        // Given: a request body to approve the workflow
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId]
          }
        }

        // When: agent with proper permissions attempts to vote
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        // Expect: a 202 Accepted status and the vote recorded in the database
        expect(response).toHaveStatusCode(HttpStatus.ACCEPTED)

        const tasks = await recalculationQueue.getWaiting()

        expect(tasks).toHaveLength(1)
        expect(tasks[0]).toMatchObject({data: {workflowId: workflowForVoting.id}})
      })
    })

    describe("bad cases", () => {
      it("should return 401 UNAUTHORIZED if no token is provided", async () => {
        // Given: vote request body
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId]
          }
        }

        // When: vote request is sent without token
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`).build().send(requestBody)

        // Expect: unauthorized status
        expect(response).toHaveStatusCode(HttpStatus.UNAUTHORIZED)
      })

      it("should return 400 BAD_REQUEST for non-existent workflow", async () => {
        // Given: non-existent workflow ID and vote request
        const nonExistentWorkflowId = randomUUID()
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId]
          }
        }

        // When: agent votes on non-existent workflow
        const response = await post(app, `${endpoint}/${nonExistentWorkflowId}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        // Expect: workflow not found error
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("WORKFLOW_NOT_FOUND")
      })

      it("should return 422 UNPROCESSABLE_ENTITY if agent is not in required group", async () => {
        // Given: vote request body
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId]
          }
        }

        // When: agent not in required group attempts to vote
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(testAgentNotInGroup.token)
          .build()
          .send(requestBody)

        // Expect: unprocessable entity due to missing group membership
        expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
        expect(response.body).toHaveErrorCode("ENTITY_NOT_IN_REQUIRED_GROUP")
      })

      it("should return 400 BAD_REQUEST for invalid vote type", async () => {
        // Given: request body with invalid vote type
        const requestBody = {
          voteType: {
            type: "MAYBE_LATER"
          }
        }

        // When: agent sends invalid vote type
        const response = await post(app, `${endpoint}/${workflowForVoting.id}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        // Expect: bad request with invalid vote type error
        expect(response).toHaveStatusCode(HttpStatus.BAD_REQUEST)
        expect(response.body).toHaveErrorCode("VOTE_TYPE_INVALID")
      })

      it("should return 422 UNPROCESSABLE_ENTITY for completed workflow", async () => {
        // Given: workflow in completed status
        const completedWorkflow = await createMockWorkflowInDb(prisma, {
          name: "Completed-Agent-Workflow",
          status: WorkflowStatus.APPROVED,
          workflowTemplateId: mockWorkflowTemplate.id
        })
        const requestBody: WorkflowVoteRequestApi = {
          voteType: {
            type: "APPROVE",
            votedForGroups: [mockGroupId]
          }
        }

        // When: agent attempts to vote on completed workflow
        const response = await post(app, `${endpoint}/${completedWorkflow.id}/vote`)
          .withToken(testAgent.token)
          .build()
          .send(requestBody)

        // Expect: unprocessable entity due to workflow status
        expect(response).toHaveStatusCode(HttpStatus.UNPROCESSABLE_ENTITY)
        expect(response.body).toHaveErrorCode("WORKFLOW_ALREADY_APPROVED")
      })
    })
  })
})
