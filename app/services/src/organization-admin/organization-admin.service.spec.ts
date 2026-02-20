// eslint-disable-next-line node/no-unpublished-import
import {Test, TestingModule} from "@nestjs/testing"
import {OrganizationAdminService} from "./organization-admin.service"
import {ORGANIZATION_ADMIN_REPOSITORY_TOKEN} from "./interfaces"
import * as TE from "fp-ts/TaskEither"
import {isRight, isLeft} from "fp-ts/Either"
import {AuthenticatedEntity, OrgRole, User} from "@domain"

// Manual mock implementation
const mockRepository = {
  createOrganizationAdmin: jest.fn(),
  listOrganizationAdmins: jest.fn(),
  removeOrganizationAdminIfNotLast: jest.fn(),
  removeOrganizationAdminByEmailIfNotLast: jest.fn()
}

const mockMemberUser = {
  id: "user-123",
  email: "member@example.com",
  displayName: "Member User",
  createdAt: new Date(),
  orgRole: OrgRole.MEMBER,
  roles: [],
  occ: BigInt(1)
} as User & {occ: bigint}

const mockAdminUser = {
  id: "admin-123",
  email: "admin@example.com",
  displayName: "Admin User",
  createdAt: new Date(),
  orgRole: OrgRole.ADMIN,
  roles: [],
  occ: BigInt(1)
} as User & {occ: bigint}

const mockMemberEntity: AuthenticatedEntity = {
  entityType: "user",
  user: mockMemberUser
}

const mockAdminEntity: AuthenticatedEntity = {
  entityType: "user",
  user: mockAdminUser
}

describe("OrganizationAdminService Security", () => {
  let service: OrganizationAdminService

  beforeEach(async () => {
    // Reset mocks
    jest.clearAllMocks()

    // Mock successful list response
    mockRepository.listOrganizationAdmins.mockReturnValue(
      TE.right({
        admins: [],
        page: 1,
        limit: 20,
        total: 0
      })
    )

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationAdminService,
        {
          provide: ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
          useValue: mockRepository
        }
      ]
    }).compile()

    service = module.get<OrganizationAdminService>(OrganizationAdminService)
  })

  it("should return requestor_not_authorized when user is not admin", async () => {
    const result = await service.listOrganizationAdmins({
      organizationName: "default",
      requestor: mockMemberEntity
    })()

    expect(isLeft(result)).toBe(true)
    if (isLeft(result)) {
      expect(result.left).toBe("requestor_not_authorized")
    }

    // Repository should NOT be called
    expect(mockRepository.listOrganizationAdmins).not.toHaveBeenCalled()
  })

  it("should list admins when user is admin", async () => {
    const result = await service.listOrganizationAdmins({
      organizationName: "default",
      requestor: mockAdminEntity
    })()

    expect(isRight(result)).toBe(true)
    // Repository SHOULD be called
    expect(mockRepository.listOrganizationAdmins).toHaveBeenCalled()
  })
})
