import {PrismaClient} from "@prisma/client"

export async function getUserOcc(prisma: PrismaClient, userId: string): Promise<bigint> {
  const user = await prisma.user.findUnique({where: {id: userId}})
  if (!user) throw new Error(`User ${userId} not found`)
  return user.occ
}
