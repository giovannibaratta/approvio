import {Prisma, PrismaClient, User as PrismaUser} from "@prisma/client"
import {OrgRole, User} from "@domain"
import {mapToDomainVersionedUser} from "@external/database/shared"
import {isLeft} from "fp-ts/lib/Either"
// eslint-disable-next-line node/no-unpublished-import
import {Chance} from "chance"

const chance = Chance()

export async function createMockUserInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.UserCreateInput, "orgRole">> & {orgRole?: OrgRole}
): Promise<PrismaUser> {
  const randomUser: Prisma.UserCreateInput = {
    id: chance.guid({
      version: 4
    }),
    displayName: chance.name(),
    email: chance.email(),
    occ: 0,
    createdAt: new Date(),
    orgRole: chance.pickone(Object.values(OrgRole))
  }

  const data: Prisma.UserCreateInput = {
    ...randomUser,
    ...overrides
  }

  const user = await prisma.user.create({data})
  return user
}

export async function createDomainMockUserInDb(
  prisma: PrismaClient,
  overrides: Parameters<typeof createMockUserInDb>[1]
): Promise<User> {
  const dbUser = await createMockUserInDb(prisma, overrides)
  const eitherUser = mapToDomainVersionedUser(dbUser)
  if (isLeft(eitherUser)) throw new Error("Unable to create mock user")
  return eitherUser.right
}
