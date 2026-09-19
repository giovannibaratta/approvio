import {User, Agent, StepUpContext} from "@domain"
import {ConfigProvider} from "@external/config"
import {JwtService} from "@nestjs/jwt"
import {PrismaClient} from "@prisma/client"
import {TokenPayloadBuilder, TokenPayloadForSigning} from "@services"
import {createDomainMockUserInDb} from "./mock-data"
import {UserWithToken} from "./types"
import {v7 as uuidv7} from "uuid"

/**
 * Test helper class for building and signing token payloads with sensible defaults.
 * Decouples non-auth integration tests from production TokenPayloadBuilder contract details.
 */
export class TestTokenBuilder {
  static fromUser(
    user: User,
    configProvider: ConfigProvider,
    options?: {
      providerId?: string
      sessionId?: string
      contextVersion?: bigint
      stepUpContext?: StepUpContext
    }
  ): TokenPayloadForSigning {
    const defaultProviderId = options?.providerId ?? "custom"
    return TokenPayloadBuilder.fromUser(user, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience],
      email: "test-user@example.com",
      providerId: defaultProviderId,
      sessionId: options?.sessionId ?? "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e62",
      sessionContextVersion: options?.contextVersion ?? 0n,
      stepUpContext: options?.stepUpContext
    })
  }

  static fromAgent(agent: Agent, configProvider: ConfigProvider): TokenPayloadForSigning {
    return TokenPayloadBuilder.fromAgent(agent, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience]
    })
  }

  static signUserToken(
    jwtService: JwtService,
    configProvider: ConfigProvider,
    user: User,
    options?: {
      providerId?: string
      sessionId?: string
      contextVersion?: bigint
      stepUpContext?: StepUpContext
      expiresIn?: number
    }
  ): string {
    const payload = TestTokenBuilder.fromUser(user, configProvider, options)
    return jwtService.sign(payload, options?.expiresIn ? {expiresIn: options.expiresIn} : undefined)
  }

  static signAgentToken(
    jwtService: JwtService,
    configProvider: ConfigProvider,
    agent: Agent,
    options?: {
      expiresIn?: number
    }
  ): string {
    const payload = TestTokenBuilder.fromAgent(agent, configProvider)
    return jwtService.sign(payload, options?.expiresIn ? {expiresIn: options.expiresIn} : undefined)
  }
}

/**
 * High-level test helper that creates a user in the database and returns the User entity along with a signed JWT.
 */
export async function createAuthenticatedUserInDb(
  prisma: PrismaClient,
  jwtService: JwtService,
  configProvider: ConfigProvider,
  overrides?: Parameters<typeof createDomainMockUserInDb>[1] & {
    providerId?: string
    sessionId?: string
    contextVersion?: bigint
    stepUpContext?: StepUpContext
    expiresIn?: number
  }
): Promise<UserWithToken> {
  const user = await createDomainMockUserInDb(prisma, overrides)
  const providerId = overrides?.providerId ?? "custom"
  const sessionId = overrides?.sessionId ?? uuidv7()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000)
  await prisma.browserSession.create({
    data: {
      id: sessionId,
      accountId: user.accountId,
      providerId: providerId,
      contextVersion: overrides?.contextVersion ?? 0n,
      selectedOrganizationId: user.organizationId,
      transport: "browser",
      status: "active",
      expiresAt,
      createdAt: now,
      updatedAt: now,
      occ: 0n
    }
  })
  const token = TestTokenBuilder.signUserToken(jwtService, configProvider, user, {
    ...overrides,
    providerId,
    sessionId
  })
  return {user, token}
}
