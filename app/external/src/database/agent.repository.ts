import {Agent, Versioned} from "@domain"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable, Logger} from "@nestjs/common"
import {Agent as PrismaAgent, Prisma} from "@prisma/client"
import {AgentRepository, AgentCreateError, AgentGetError, AgentUpdateError} from "@services"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"
import {TaskEither} from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {DatabaseClient} from "./database-client"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"
import {mapAgentToDomain, mapRolesToPrisma, mapToDomainVersionedAgent} from "./shared"

@Injectable()
export class AgentDbRepository implements AgentRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  persistAgent(agent: Agent): TaskEither<AgentCreateError, Agent> {
    return pipe(agent, TE.right, TE.chainW(this.persistAgentTask()), TE.chainEitherKW(mapAgentToDomain))
  }

  getAgentByName(agentName: string): TaskEither<AgentGetError, Agent> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.agent.findUnique({
            where: {agentName}
          }),
        this.mapGetError
      ),
      chainNullableToLeft("agent_not_found" as const),
      TE.chainEitherKW(mapAgentToDomain)
    )
  }

  getAgentById(agentId: string): TaskEither<AgentGetError, Versioned<Agent>> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.cx.agent.findUnique({
            where: {id: agentId}
          }),
        this.mapGetError
      ),
      chainNullableToLeft("agent_not_found" as const),
      TE.chainEitherKW(mapToDomainVersionedAgent)
    )
  }

  updateAgent(agent: Versioned<Agent>): TaskEither<AgentUpdateError, Agent> {
    return TE.tryCatchK(
      async () => {
        const updatedAgent = await this.dbClient.cx.agent.update({
          where: {id: agent.id, occ: agent.occ},
          data: {
            roles: mapRolesToPrisma(agent.roles),
            occ: {
              increment: 1
            }
          }
        })

        const mappedAgent = mapAgentToDomain(updatedAgent)
        if (E.isLeft(mappedAgent)) throw new Error("Failed to map updated agent to domain")

        return mappedAgent.right
      },
      error => {
        if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Agent)) return "concurrent_modification_error" as const

        Logger.error("Error while updating agent roles", error)
        return "unknown_error" as const
      }
    )()
  }

  private persistAgentTask() {
    return (agent: Agent): TaskEither<AgentCreateError, PrismaAgent> =>
      TE.tryCatch(
        () =>
          this.dbClient.cx.agent.create({
            data: this.mapDomainAgentToPrisma(agent)
          }),
        this.mapCreateError
      )
  }

  private mapDomainAgentToPrisma(agent: Agent) {
    return {
      id: agent.id,
      agentName: agent.agentName,
      base64PublicKey: Buffer.from(agent.publicKey).toString("base64"),
      roles: agent.roles as unknown as Prisma.InputJsonValue, // Prisma JSON serialization
      createdAt: agent.createdAt,
      occ: POSTGRES_BIGINT_LOWER_BOUND
    }
  }

  private mapCreateError = (error: unknown): AgentCreateError => {
    if (isPrismaUniqueConstraintError(error, ["agent_name"])) return "agent_name_already_exists"
    return "unknown_error"
  }

  private mapGetError = (): AgentGetError => {
    return "unknown_error"
  }
}
