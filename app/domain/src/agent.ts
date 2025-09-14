import {Either, left, right} from "fp-ts/Either"
import {pipe} from "fp-ts/function"
import * as E from "fp-ts/Either"
import {KeyPairSyncResult, randomUUID} from "crypto"
import {isUUIDv4, PrefixUnion} from "@utils"
import {generateKeyPairSync} from "crypto"
import {BoundRole} from "./role"

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
  roles: ReadonlyArray<BoundRole<string>>
}

interface AgentCreateData {
  agentName: string
}

type AgentNameValidationError = PrefixUnion<"agent", "name_empty" | "name_too_long">
type IdValidationError = PrefixUnion<"agent", "invalid_uuid">
type KeyGenerationError = PrefixUnion<"agent", "key_generation_failed">

export type AgentValidationError = IdValidationError | AgentNameValidationError
export type AgentCreateValidationError = AgentNameValidationError
export type AgentCreationError = KeyGenerationError | AgentNameValidationError

export class AgentFactory {
  /**
   * Creates and validates a new agent entity with generated keys
   * @param data The agent creation data
   * @returns Either validation/creation error or created agent
   */
  static create(data: AgentCreateData): Either<AgentCreationError, AgentWithPrivateKey> {
    return pipe(
      E.Do,
      E.bindW("data", () => E.right(data)),
      E.bindW("validatedData", ({data}) => this.validateAgentCreateData(data)),
      E.bindW("keyPair", () => this.generateKeyPair()),
      E.map(({validatedData, keyPair}) => {
        const agent: AgentWithPrivateKey = {
          id: randomUUID(),
          agentName: validatedData.agentName,
          publicKey: keyPair.publicKey,
          privateKey: keyPair.privateKey,
          createdAt: new Date(),
          roles: []
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
  static validate(data: AgentData): Either<AgentValidationError, Agent> {
    return pipe(
      E.Do,
      E.bindW("validatedId", () => this.validateId(data.id)),
      E.bindW("validatedAgentName", () => this.validateAgentName(data.agentName)),
      E.map(({validatedId, validatedAgentName}) => {
        return {
          id: validatedId,
          agentName: validatedAgentName,
          publicKey: data.publicKey,
          createdAt: data.createdAt,
          roles: data.roles || []
        }
      })
    )
  }

  /**
   * Adds roles/permissions to an agent
   * @param agent The agent to update
   * @param newRoles The new roles to add
   * @returns Either validation error or updated agent
   */
  static addPermissions(agent: Agent, newRoles: ReadonlyArray<BoundRole<string>>): Either<AgentValidationError, Agent> {
    const updatedAgent: Agent = {
      ...agent,
      roles: [...agent.roles, ...newRoles]
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
    return right(agentName)
  }
}
