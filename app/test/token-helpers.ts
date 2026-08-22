import {User, Agent, StepUpContext} from "@domain"
import {ConfigProvider} from "@external/config"
import {JwtService} from "@nestjs/jwt"
import {PrismaClient} from "@prisma/client"
import {TokenPayloadBuilder, TokenPayloadForSigning} from "@services"
import {createDomainMockUserInDb} from "./mock-data"
import {UserWithToken} from "./types"

/**
 * Test helper class for building and signing token payloads with sensible defaults.
 * Decouples non-auth integration tests from production TokenPayloadBuilder contract details.
 */
export class TestTokenBuilder {
  static fromUser(
    user: User,
    configProvider: ConfigProvider,
    options?: {
      stepUpContext?: StepUpContext
    }
  ): TokenPayloadForSigning {
    return TokenPayloadBuilder.fromUser(user, {
      issuer: configProvider.jwtConfig.issuer,
      audience: [configProvider.jwtConfig.audience],
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
    stepUpContext?: StepUpContext
    expiresIn?: number
  }
): Promise<UserWithToken> {
  const user = await createDomainMockUserInDb(prisma, overrides)
  const token = TestTokenBuilder.signUserToken(jwtService, configProvider, user, overrides)
  return {user, token}
}
