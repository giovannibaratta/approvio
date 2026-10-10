import {AccountFactory} from "@domain"
import {ConfigProvider} from "@external/config"
import {JwtService} from "@nestjs/jwt"
import {PrismaClient} from "@prisma/client"
import {TokenPayloadBuilder} from "@services"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

export async function createPlatformSessionInDb(
  prisma: PrismaClient,
  jwt: JwtService,
  config: ConfigProvider,
  contextVersion = 0n
) {
  const id = uuidv7()
  const sessionId = uuidv7()
  const providerId = "custom"
  const now = new Date()
  const account = unwrapRight(
    AccountFactory.validate(
      await prisma.platformAccount.create({
        data: {
          id,
          displayName: "Platform account",
          profileEmail: `${id}@example.test`,
          status: "active",
          createdAt: now,
          updatedAt: now,
          occ: 0n
        }
      })
    )
  )
  await prisma.browserSession.create({
    data: {
      id: sessionId,
      accountId: id,
      providerId: providerId,
      contextVersion,
      selectedOrganizationId: null,
      transport: "browser",
      status: "active",
      expiresAt: new Date(now.getTime() + 3600000),
      createdAt: now,
      updatedAt: now,
      occ: 0n
    }
  })
  const token = jwt.sign(
    TokenPayloadBuilder.fromPlatformAccount(account, {
      issuer: config.jwtConfig.issuer,
      audience: [config.jwtConfig.audience],
      providerId: providerId,
      sessionId,
      sessionContextVersion: contextVersion
    })
  )
  return {account, sessionId, providerId: providerId, token}
}
