import {fromPromise, fromEitherPromise} from "./repository-operation"
import {Injectable, Logger} from "@nestjs/common"
import {Agent, DecoratedAgent, TenantContext} from "@domain"
import {AgentCreateError, AgentGetError, AgentRepository, AgentUpdateError} from "@services"
import {Agent as PrismaAgent, Prisma} from "@prisma/client"
import * as E from "fp-ts/Either"
import * as TE from "fp-ts/TaskEither"
import {pipe} from "fp-ts/function"
import {AgentTenantClient} from "./tenant-database-clients"
import {isPrismaRecordNotFoundError, isPrismaUniqueConstraintError} from "./errors"
import {mapAgentToDomain, mapRolesToPrisma} from "./shared"
import {chainNullableToLeft} from "./utils"
import {POSTGRES_BIGINT_LOWER_BOUND} from "./constants"

@Injectable()
export class AgentDbRepository implements AgentRepository {
  constructor(private readonly dbClient: AgentTenantClient) {}

  persistAgent(agent: Agent): TE.TaskEither<AgentCreateError, Agent> {
    return pipe(agent, TE.right, TE.chainW(this.persistAgentTask()), TE.chainEitherKW(mapAgentToDomain))
  }

  getAgentByName(context: TenantContext, agentName: string): TE.TaskEither<AgentGetError, DecoratedAgent<{occ: true}>> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.agent.findUnique({
            where: {organizationId_agentName: {organizationId: context.organizationId, agentName}}
          }),
        this.mapGetError
      ),
      chainNullableToLeft("agent_not_found" as const),
      TE.chainEitherKW(mapToDecoratedAgent)
    )
  }

  getAgentById(context: TenantContext, agentId: string): TE.TaskEither<AgentGetError, DecoratedAgent<{occ: true}>> {
    return pipe(
      fromPromise(
        () =>
          this.dbClient.cx.agent.findUnique({
            where: {organizationId_id: {organizationId: context.organizationId, id: agentId}}
          }),
        this.mapGetError
      ),
      chainNullableToLeft("agent_not_found" as const),
      TE.chainEitherKW(mapToDecoratedAgent)
    )
  }

  updateAgent(
    context: TenantContext,
    agent: DecoratedAgent<{occ: true}>
  ): TE.TaskEither<AgentUpdateError, DecoratedAgent<{occ: true}>> {
    return fromEitherPromise(
      async () => {
        const updatedAgent = await this.dbClient.cx.agent.update({
          where: {id: agent.id, organizationId: context.organizationId, occ: agent.occ},
          data: {
            status: agent.status,
            roles: mapRolesToPrisma(agent.roles),
            updatedAt: agent.updatedAt,
            occ: {increment: 1}
          }
        })

        return mapToDecoratedAgent(updatedAgent)
      },
      error => {
        if (isPrismaRecordNotFoundError(error, Prisma.ModelName.Agent)) return "concurrent_modification_error" as const

        Logger.error("Error while updating agent roles", error)
        return "unknown_error" as const
      }
    )
  }

  private persistAgentTask() {
    return (agent: Agent): TE.TaskEither<AgentCreateError, PrismaAgent> =>
      fromPromise(() => this.dbClient.cx.agent.create({data: this.mapDomainAgentToPrisma(agent)}), this.mapCreateError)
  }

  private mapDomainAgentToPrisma(agent: Agent) {
    return {
      id: agent.id,
      organizationId: agent.organizationId,
      agentName: agent.agentName,
      base64PublicKey: Buffer.from(agent.publicKey).toString("base64"),
      status: agent.status,
      roles: mapRolesToPrisma(agent.roles),
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      occ: POSTGRES_BIGINT_LOWER_BOUND
    }
  }

  private mapCreateError = (error: unknown): AgentCreateError => {
    if (isPrismaUniqueConstraintError(error, ["organization_id", "agent_name"], "agents_organization_name_unique"))
      return "agent_name_already_exists"
    return "unknown_error"
  }

  private mapGetError = (error: unknown): AgentGetError => {
    Logger.error("Agent repository lookup failed", error instanceof Error ? error.name : String(error))
    return "unknown_error"
  }
}

function mapToDecoratedAgent(record: PrismaAgent) {
  return pipe(
    mapAgentToDomain(record),
    E.map(agent => ({...agent, occ: record.occ}))
  )
}
