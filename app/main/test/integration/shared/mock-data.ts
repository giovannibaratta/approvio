import {Prisma, PrismaClient, User as PrismaUser, WorkflowTemplate as PrismaWorkflowTemplate} from "@prisma/client"
import {ApprovalRuleType, OrgRole, User} from "@domain"
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

export async function createMockWorkflowTemplateInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.WorkflowTemplateCreateInput, "id" | "occ" | "createdAt" | "updatedAt">>
): Promise<PrismaWorkflowTemplate> {
  const randomTemplate: Prisma.WorkflowTemplateCreateInput = {
    id: chance.guid({
      version: 4
    }),
    name: chance.guid({version: 4}),
    description: chance.sentence(),
    approvalRule: {
      type: ApprovalRuleType.GROUP_REQUIREMENT,
      groupId: chance.guid({
        version: 4
      }),
      minCount: 1
    },
    actions: [],
    defaultExpiresInHours: chance.integer({min: 1, max: 168}), // 1 hour to 1 week
    occ: 1,
    createdAt: new Date(),
    updatedAt: new Date()
  }

  const data: Prisma.WorkflowTemplateCreateInput = {
    ...randomTemplate,
    ...overrides
  }

  const template = await prisma.workflowTemplate.create({data})
  return template
}
