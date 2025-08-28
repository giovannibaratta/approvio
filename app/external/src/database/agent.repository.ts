import {Agent} from "@domain"
import {isPrismaUniqueConstraintError} from "@external/database/errors"
import {Injectable} from "@nestjs/common"
import {Agent as PrismaAgent} from "@prisma/client"
import {AgentRepository, AgentCreateError, AgentGetError, AgentKeyDecodeError} from "@services"
import * as TE from "fp-ts/lib/TaskEither"
import {TaskEither} from "fp-ts/lib/TaskEither"
import {pipe} from "fp-ts/lib/function"
import {DatabaseClient} from "./database-client"
import * as E from "fp-ts/lib/Either"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"

@Injectable()
export class AgentDbRepository implements AgentRepository {
  constructor(private readonly dbClient: DatabaseClient) {}

  persistAgent(agent: Agent): TaskEither<AgentCreateError, Agent> {
    return pipe(agent, TE.right, TE.chainW(this.persistAgentTask()), TE.chainEitherKW(this.mapPrismaAgentToDomain))
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
      TE.chainEitherKW(this.mapPrismaAgentToDomain)
    )
  }

  getAgentById(agentId: string): TaskEither<AgentGetError, Agent> {
    return pipe(
      TE.tryCatch(
        () =>
          this.dbClient.agent.findUnique({
            where: {id: agentId}
          }),
        this.mapGetError
      ),
      chainNullableToLeft("agent_not_found" as const),
      TE.chainEitherKW(this.mapPrismaAgentToDomain)
    )
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
      createdAt: agent.createdAt,
      occ: POSTGRES_BIGINT_LOWER_BOUND
    }
  }

  private mapPrismaAgentToDomain(prismaAgent: PrismaAgent): E.Either<AgentKeyDecodeError, Agent> {
    const decodePublicKey = E.tryCatch(
      () => Buffer.from(prismaAgent.base64PublicKey, "base64").toString("utf8"),
      () => "agent_key_decode_error" as const
    )

    return pipe(
      decodePublicKey,
      E.map(decodedPublicKey => {
        const agent: Agent = {
          id: prismaAgent.id,
          agentName: prismaAgent.agentName,
          publicKey: decodedPublicKey,
          createdAt: prismaAgent.createdAt
        }
        return agent
      })
    )
  }

  private mapCreateError = (error: unknown): AgentCreateError => {
    if (isPrismaUniqueConstraintError(error, ["agent_name"])) return "agent_name_already_exists"
    return "unknown_error"
  }

  private mapGetError = (): AgentGetError => {
    return "unknown_error"
  }
}
