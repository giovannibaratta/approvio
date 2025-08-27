import {
  Prisma,
  PrismaClient,
  User as PrismaUser,
  OrganizationAdmin as PrismaOrganizationAdmin,
  WorkflowTemplate as PrismaWorkflowTemplate,
  Workflow as PrismaWorkflow,
  Group as PrismaGroup,
  Space as PrismaSpace
} from "@prisma/client"
import {ApprovalRuleType, BoundRole, User, WorkflowStatus} from "@domain"
import {mapToDomainVersionedUser} from "@external/database/shared"
import {isLeft} from "fp-ts/lib/Either"
// eslint-disable-next-line node/no-unpublished-import
import {Chance} from "chance"
import {
  ConfigProvider,
  ConfigProviderInterface,
  EmailProviderConfig,
  JwtConfig,
  OidcProviderConfig
} from "@external/config"
import {Option} from "fp-ts/lib/Option"
import * as O from "fp-ts/lib/Option"

const chance = Chance()

export class MockConfigProvider implements ConfigProviderInterface {
  dbConnectionUrl: string
  emailProviderConfig: Option<EmailProviderConfig>
  oidcConfig: OidcProviderConfig
  jwtConfig: JwtConfig

  private constructor(
    originalProvider?: ConfigProvider,
    mocks: {dbConnectionUrl?: string; emailProviderConfig?: EmailProviderConfig} = {}
  ) {
    const provider: ConfigProviderInterface = originalProvider ?? {
      dbConnectionUrl: "postgresql://test:test@localhost:5433/postgres?schema=public",
      emailProviderConfig: O.none,
      oidcConfig: {
        issuerUrl: "http://localhost:4011",
        clientId: "integration-test-client-id",
        clientSecret: "integration-test-client-secret",
        redirectUri: "http://localhost:3000/auth/callback",
        allowInsecure: true
      },
      jwtConfig: {
        secret: "test-jwt-secret-for-integration-tests",
        trustedIssuers: ["idp.test.localhost"],
        issuer: "idp.test.localhost",
        audience: "approvio.test.localhost"
      }
    }

    this.dbConnectionUrl = mocks.dbConnectionUrl || provider.dbConnectionUrl
    this.emailProviderConfig =
      mocks.emailProviderConfig !== undefined ? O.some(mocks.emailProviderConfig) : provider.emailProviderConfig
    this.oidcConfig = provider.oidcConfig
    this.jwtConfig = provider.jwtConfig
  }

  static fromDbConnectionUrl(dbConnectionUrl: string): MockConfigProvider {
    return new MockConfigProvider(undefined, {dbConnectionUrl})
  }

  static fromOriginalProvider(
    mocks: {dbConnectionUrl?: string; emailProviderConfig?: EmailProviderConfig} = {}
  ): MockConfigProvider {
    const provider = new ConfigProvider()
    return new MockConfigProvider(provider, mocks)
  }
}

type PrismaUserWithOrgAdmin = PrismaUser & {
  organizationAdmins: PrismaOrganizationAdmin | null
}

export async function createMockUserInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.UserCreateInput, "roles">> & {
    orgAdmin?: boolean
    roles?: ReadonlyArray<BoundRole<string>>
  }
): Promise<PrismaUserWithOrgAdmin> {
  const randomUser: Prisma.UserCreateInput = {
    id: chance.guid({
      version: 4
    }),
    displayName: chance.name(),
    email: chance.email(),
    occ: 0,
    createdAt: new Date()
  }

  const {roles, orgAdmin, ...userOverrides} = overrides || {}
  const data: Prisma.UserCreateInput = {
    ...randomUser,
    ...userOverrides,
    roles: roles ? JSON.parse(JSON.stringify(roles)) : null
  }

  const user = await prisma.user.create({data})
  if (orgAdmin !== undefined && orgAdmin) {
    await prisma.organizationAdmin.create({
      data: {
        createdAt: new Date(),
        email: user.email,
        id: chance.guid()
      }
    })
  }

  // Return user with organizationAdmin relationship included
  const userWithOrgAdmin = await prisma.user.findUnique({
    where: {id: user.id},
    include: {organizationAdmins: true}
  })

  if (!userWithOrgAdmin) {
    throw new Error("Unable to fetch created user")
  }

  return userWithOrgAdmin
}

export async function createDomainMockUserInDb(
  prisma: PrismaClient,
  overrides?: Parameters<typeof createMockUserInDb>[1]
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

export async function createMockSpaceInDb(
  prisma: PrismaClient,
  overrides?: Partial<Omit<Prisma.SpaceCreateInput, "id" | "occ">>
): Promise<PrismaSpace> {
  const randomSpace: Prisma.SpaceCreateInput = {
    id: chance.guid({version: 4}),
    name: chance.company(),
    description: chance.sentence(),
    createdAt: new Date(),
    updatedAt: new Date(),
    occ: 1n
  }

  const data: Prisma.SpaceCreateInput = {
    ...randomSpace,
    ...overrides
  }

  const space = await prisma.space.create({data})
  return space
}
