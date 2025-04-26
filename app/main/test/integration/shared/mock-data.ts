import {randomUUID} from "crypto"
import {PrismaClient, User as PrismaUser} from "@prisma/client"

export async function createTestUser(prisma: PrismaClient, displayName: string, email: string): Promise<PrismaUser> {
  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      displayName: displayName,
      email: email,
      createdAt: new Date(),
      occ: 1
    }
  })
  return user
}
