import {
  Prisma,
  PrismaClient,
  User as PrismaUser,
  WorkflowTemplate as PrismaWorkflowTemplate,
  Workflow as PrismaWorkflow,
  Group as PrismaGroup
} from "@prisma/client"
import {ApprovalRuleType, OrgRole, User, WorkflowStatus} from "@domain"
import {mapToDomainVersionedUser} from "@external/database/shared"
import {isLeft} from "fp-ts/lib/Either"
// eslint-disable-next-line node/no-unpublished-import
import {Chance} from "chance"
import {EmailProviderConfig} from "@external/config"
import {Option} from "fp-ts/lib/Option"
import * as O from "fp-ts/lib/Option"

const chance = Chance()

export class MockConfigProvider {
  dbConnectionUrl: string
  emailProviderConfig: Option<EmailProviderConfig>

  constructor(dbConnectionUrl: string) {
    this.dbConnectionUrl = dbConnectionUrl
    this.emailProviderConfig = O.none
  }
}

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
  overrides?: Partial<Omit<Prisma.WorkflowTemplateCreateInput, "id" | "occ">>
): Promise<PrismaWorkflowTemplate> {
  const dates = generate_consistent_dates_for_workflow_template(overrides)
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
    status: "ACTIVE",
    allowVotingOnDeprecatedTemplate: true,
    version: "latest",
    occ: 1,
    createdAt: dates.createdAt,
    updatedAt: dates.updatedAt
  }

  const data: Prisma.WorkflowTemplateCreateInput = {
    ...randomTemplate,
    ...overrides
  }

  const template = await prisma.workflowTemplate.create({data})
  return template
}

export async function createMockWorkflowInDb(
  prisma: PrismaClient,
  overrides: {
    name: string
    description?: string
    status?: WorkflowStatus
    workflowTemplateId?: string
    expiresAt?: Date | "active" | "expired"
  }
): Promise<PrismaWorkflow> {
  let workflowId: string | undefined = overrides.workflowTemplateId

  if (!workflowId) {
    const template = await createMockWorkflowTemplateInDb(prisma)
    workflowId = template.id
  }

  const dates = generate_consistent_dates_for_workflow(overrides.expiresAt)

  const workflow = await prisma.workflow.create({
    data: {
      id: chance.guid({version: 4}),
      name: overrides.name,
      description: overrides.description,
      status: overrides.status ?? WorkflowStatus.APPROVED,
      recalculationRequired: false,
      workflowTemplateId: workflowId,
      createdAt: dates.createdAt,
      updatedAt: dates.updatedAt,
      expiresAt: dates.expiresAt,
      occ: 1n
    }
  })
  return workflow
}

function generate_consistent_dates_for_workflow(optionalExpiresAt: Date | "active" | "expired" | undefined): {
  expiresAt: Date
  createdAt: Date
  updatedAt: Date
} {
  if (optionalExpiresAt === undefined) {
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)
    const updatedAt = randomDateBefore(expiresAt)
    const createdAt = randomDateBefore(updatedAt)
    return {expiresAt, createdAt, updatedAt}
  }

  if (typeof optionalExpiresAt !== "string") {
    const expiresAt = optionalExpiresAt
    const updatedAt = randomDateBefore(expiresAt)
    const createdAt = randomDateBefore(updatedAt)
    return {expiresAt, createdAt, updatedAt}
  }

  if (optionalExpiresAt === "active") {
    const now = new Date(Date.now())
    const expiresAt = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30)
    const updatedAt = randomDateBefore(now)
    const createdAt = randomDateBefore(updatedAt)
    return {expiresAt, createdAt, updatedAt}
  }

  const now = new Date(Date.now())
  const expiresAt = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30)
  const updatedAt = randomDateBefore(expiresAt)
  const createdAt = randomDateBefore(updatedAt)
  return {expiresAt, createdAt, updatedAt}
}

function generate_consistent_dates_for_workflow_template(
  overrides?: Partial<Pick<Prisma.WorkflowTemplateCreateInput, "updatedAt" | "createdAt">>
): {
  createdAt: Date | string
  updatedAt: Date | string
} {
  if (overrides?.updatedAt && overrides?.createdAt && overrides.updatedAt < overrides.createdAt)
    throw new Error("Updated at must be after created at")

  if (overrides?.updatedAt && overrides?.createdAt)
    return {createdAt: overrides.createdAt, updatedAt: overrides.updatedAt}
  if (overrides?.updatedAt) return {createdAt: randomDateBefore(overrides.updatedAt), updatedAt: overrides.updatedAt}
  if (overrides?.createdAt) return {createdAt: overrides.createdAt, updatedAt: randomDateAfter(overrides.createdAt)}

  const now = new Date(Date.now())
  const updatedAt = randomDateBefore(now)
  const createdAt = randomDateBefore(updatedAt)
  return {createdAt, updatedAt}
}

export function randomDateBefore(date: Date | string): Date {
  if (typeof date === "string") date = new Date(date)
  return new Date(date.getTime() - chance.integer({min: 1, max: 1000 * 60 * 60 * 24 * 30}))
}

export function randomDateAfter(date: Date | string): Date {
  if (typeof date === "string") date = new Date(date)
  return new Date(date.getTime() + chance.integer({min: 1, max: 1000 * 60 * 60 * 24 * 30}))
}

export async function createMockGroupInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.GroupCreateInput, "id" | "occ">>
): Promise<PrismaGroup> {
  const randomGroup: Prisma.GroupCreateInput = {
    id: chance.guid({version: 4}),
    name: chance.company(),
    description: chance.sentence(),
    createdAt: new Date(),
    updatedAt: new Date(),
    occ: 1
  }

  const data: Prisma.GroupCreateInput = {
    ...randomGroup,
    ...overrides
  }

  const group = await prisma.group.create({data})
  return group
}
