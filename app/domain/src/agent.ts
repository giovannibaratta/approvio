import {Either, left, right} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import {KeyPairSyncResult, randomUUID} from "crypto"
import {isUUIDv4, PrefixUnion, DecorableEntity, isDecoratedWith} from "@utils"
import {generateKeyPairSync} from "crypto"
import {UnconstrainedBoundRole, RoleFactory, RoleValidationError, MAX_ROLES_PER_ENTITY} from "./role"

export const AGENT_NAME_MIN_LENGTH = 1
export const AGENT_NAME_MAX_LENGTH = 1024

export type AgentWithPrivateKey = Readonly<AgentData & {readonly privateKey: string}>
export type Agent = Readonly<AgentData>
export type AgentCreate = Readonly<AgentCreateData>

interface AgentData {
  id: string
  agentName: string
  publicKey: string
  createdAt: Date
  roles: ReadonlyArray<UnconstrainedBoundRole>
}

interface AgentCreateData {
  agentName: string
}

type AgentNameValidationError = PrefixUnion<"agent", "name_empty" | "name_too_long" | "name_cannot_be_uuid">
type IdValidationError = PrefixUnion<"agent", "invalid_uuid">
type KeyGenerationError = PrefixUnion<"agent", "key_generation_failed">
type OccValidationError = PrefixUnion<"agent", "invalid_occ">

export type AgentValidationError =
  | IdValidationError
  | AgentNameValidationError
  | OccValidationError
  | PrefixUnion<"agent", RoleValidationError>
export type AgentCreateValidationError = AgentNameValidationError
export type AgentCreationError = KeyGenerationError | AgentNameValidationError

export interface AgentDecorators {
  occ: bigint
}

export type AgentDecoratorSelector = Partial<Record<keyof AgentDecorators, boolean>>

export type DecoratedAgent<T extends AgentDecoratorSelector> = DecorableEntity<Agent, AgentDecorators, T>

export function isDecoratedAgent<K extends keyof AgentDecorators>(
  agent: DecoratedAgent<AgentDecoratorSelector>,
  key: K,
  options?: AgentDecoratorSelector
): agent is DecoratedAgent<AgentDecoratorSelector & Record<K, true>> {
  return isDecoratedWith<DecoratedAgent<AgentDecoratorSelector>, AgentDecorators, AgentDecoratorSelector, K>(
    agent,
    key,
    options
  )
}

export class AgentFactory {
  /**
   * Creates and validates a new agent entity with generated keys
   * @param data The agent creation data
   * @returns Either validation/creation error or created agent
   */
  static create(data: AgentCreateData): Either<AgentCreationError | AgentValidationError, AgentWithPrivateKey> {
    return pipe(
      E.Do,
      E.bindW("data", () => E.right(data)),
      E.bindW("validatedData", ({data}) => this.validateAgentCreateData(data)),
      E.bindW("keyPair", () => this.generateKeyPair()),
      E.bindW("validatedAgent", ({validatedData, keyPair}) =>
        AgentFactory.validate({
          id: randomUUID(),
          agentName: validatedData.agentName,
          createdAt: new Date(),
          roles: [],
          publicKey: keyPair.publicKey
        })
      ),
      E.map(({validatedAgent, keyPair}) => {
        const agent: AgentWithPrivateKey = {
          ...validatedAgent,
          privateKey: keyPair.privateKey
        }
        return agent
      })
    )
  }

  /**
   * Validates agent creation data
   * @param data The agent creation data to validate
   * @returns Either validation error or validated agent creation data
   */
  static validateAgentCreateData(data: AgentCreateData): Either<AgentCreateValidationError, AgentCreate> {
    return pipe(
      E.Do,
      E.bindW("agentName", () => this.validateAgentName(data.agentName)),
      E.map(({agentName}) => {
        return {
          agentName
        }
      })
    )
  }

  /**
   * Validates a complete agent entity
   * @param data The agent data to validate
   * @returns Either validation error or validated agent
   */
  static validate<T extends AgentDecoratorSelector>(
    data: Omit<DecoratedAgent<T>, "roles"> & {readonly roles: Agent["roles"] | unknown}
  ): Either<AgentValidationError, DecoratedAgent<T>> {
    return pipe(
      E.Do,
      E.bindW("validatedId", () => this.validateId(data.id)),
      E.bindW("validatedAgentName", () => this.validateAgentName(data.agentName)),
      E.bindW("validatedRoles", () => this.validateRoles(data.roles)),
      E.bindW("baseObj", ({validatedId, validatedAgentName, validatedRoles}) => {
        return E.right({
          ...data,
          id: validatedId,
          agentName: validatedAgentName,
          roles: validatedRoles
        })
      }),
      E.bindW("validatedOcc", ({baseObj}) => this.validateOcc(baseObj)),
      E.map(({baseObj, validatedOcc}) => {
        const agent = {
          ...baseObj,
          occ: validatedOcc
        }
        return agent
      })
    )
  }

  /**
   * Creates a new Agent with additional roles assigned (additive operation)
   * @param agent Existing agent (can be regular Agent or DecoratedAgent with occ)
   * @param newRoles Array of new roles to add
   * @returns Either validation error or new Agent/DecoratedAgent with roles added (preserves input type)
   */
  static assignRoles<T extends AgentDecoratorSelector>(
    agent: DecoratedAgent<T>,
    newRoles: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<AgentValidationError, DecoratedAgent<T>> {
    const consolidatedRoles = RoleFactory.consolidateRoles([...agent.roles, ...newRoles])

    if (consolidatedRoles.length > MAX_ROLES_PER_ENTITY) return left("agent_role_total_roles_exceed_maximum")

    const updatedAgent = {
      ...agent,
      roles: consolidatedRoles
    }

    return AgentFactory.validate(updatedAgent)
  }

  /**
   * Creates a new Agent with specified roles removed
   * @param agent Existing agent (can be regular Agent or DecoratedAgent with occ)
   * @param rolesToRemove Array of roles to remove (matched by name and scope)
   * @returns Either validation error or new Agent/DecoratedAgent with roles removed (preserves input type)
   */
  static removeRoles<T extends AgentDecoratorSelector>(
    agent: DecoratedAgent<T>,
    rolesToRemove: ReadonlyArray<UnconstrainedBoundRole>
  ): Either<AgentValidationError, DecoratedAgent<T>> {
    const remainingRoles = agent.roles.filter(existingRole => {
      return !rolesToRemove.some(
        roleToRemove =>
          existingRole.name === roleToRemove.name && RoleFactory.isSameScope(existingRole.scope, roleToRemove.scope)
      )
    })

    const updatedAgent = {
      ...agent,
      roles: remainingRoles
    }

    return AgentFactory.validate(updatedAgent)
  }

  /**
   * Generates RSA key pair for agent authentication
   * @returns Either key generation error or key pair
   */
  private static generateKeyPair(): Either<KeyGenerationError, KeyPairSyncResult<string, string>> {
    try {
      const keyPair = generateKeyPairSync("rsa", {
        modulusLength: 4096,
        publicKeyEncoding: {
          type: "spki",
          format: "pem"
        },
        privateKeyEncoding: {
          type: "pkcs8",
          format: "pem"
        }
      })

      return right({
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey
      })
    } catch {
      return left("agent_key_generation_failed")
    }
  }

  private static validateId(id: string): Either<IdValidationError, string> {
    if (!isUUIDv4(id)) return left("agent_invalid_uuid")
    return right(id)
  }

  private static validateAgentName(agentName: string): Either<AgentNameValidationError, string> {
    if (!agentName || agentName.trim().length === 0) return left("agent_name_empty")
    if (agentName.length > AGENT_NAME_MAX_LENGTH) return left("agent_name_too_long")
    if (isUUIDv4(agentName)) return left("agent_name_cannot_be_uuid")
    return right(agentName)
  }

  /**
   * Validates role assignments from external data
   * @param roles Array data that should represent BoundRole array
   * @returns Either validation error or validated roles array
   */
  private static validateRoles(roles: unknown): Either<AgentValidationError, ReadonlyArray<UnconstrainedBoundRole>> {
    if (roles === null || roles === undefined) return right([])
    if (!Array.isArray(roles)) return left("agent_role_invalid_structure")

    return pipe(
      roles,
      RoleFactory.validateBoundRoles,
      E.mapLeft(error => ("agent_" + error) as AgentValidationError)
    )
  }

  private static validateOcc<T extends AgentDecoratorSelector>(
    data: DecoratedAgent<T>
  ): Either<AgentValidationError, bigint | undefined> {
    if (isDecoratedAgent(data, "occ", {occ: true})) {
      if (typeof data.occ !== "bigint") return left("agent_invalid_occ")
      return right(data.occ)
    }

    return right(undefined)
  }
}
