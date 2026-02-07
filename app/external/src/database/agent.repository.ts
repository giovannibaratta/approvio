import {Agent, Versioned} from "@domain"
import {isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable} from "@nestjs/common"
import {Agent as PrismaAgent, Prisma} from "@prisma/client"
import {AgentRepository, AgentCreateError, AgentGetError, AgentUpdateError} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import * as E from "fp-ts/lib/Either"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
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
          this.dbClient.agent.findUnique({
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
          this.dbClient.agent.findUnique({
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
        const updatedAgent = await this.dbClient.agent.update({
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
        if (isPrismaUniqueConstraintError(error, ["occ"])) {
          console.warn("Optimistic concurrency control conflict during agent role update", error)
          return "unknown_error" as const
        }

        console.error("Error while updating agent roles", error)
        return "unknown_error" as const
      }
    )()
  }

  private persistAgentTask() {
    return (agent: Agent): TaskEither<AgentCreateError, PrismaAgent> =>
      TE.tryCatch(
        () =>
          this.dbClient.agent.create({
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
