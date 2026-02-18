import {Test, TestingModule} from "@nestjs/testing"
import {OrganizationAdminService} from "@services"
import {ORGANIZATION_ADMIN_REPOSITORY_TOKEN} from "@services/organization-admin/interfaces"
import * as E from "fp-ts/Either"
import {User, AuthenticatedEntity} from "@domain"

const mockOrgAdminRepo = {
  createOrganizationAdmin: jest.fn(),
  listOrganizationAdmins: jest.fn(),
  removeOrganizationAdminIfNotLast: jest.fn(),
  removeOrganizationAdminByEmailIfNotLast: jest.fn()
}

const mockAdminUser = {
  id: "admin-id",
  email: "admin@example.com",
  orgRole: "admin",
  occ: BigInt(1)
} as unknown as User

const mockMemberUser = {
  id: "member-id",
  email: "member@example.com",
  orgRole: "member",
  occ: BigInt(1)
} as unknown as User

describe("OrganizationAdminService", () => {
  let service: OrganizationAdminService

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationAdminService,
        {
          provide: ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
          useValue: mockOrgAdminRepo
        }
      ]
    }).compile()

    service = module.get<OrganizationAdminService>(OrganizationAdminService)
    jest.clearAllMocks()
  })

  it("should be defined", () => {
    expect(service).toBeDefined()
  })

  it("should allow admin to list organization admins", async () => {
    // Given
    mockOrgAdminRepo.listOrganizationAdmins.mockReturnValue(async () =>
      E.right({admins: [], total: 0, page: 1, limit: 10})
    )

    // When
    const result = await service.listOrganizationAdmins({
      organizationName: "default",
      requestor: {entityType: "user", user: mockAdminUser} as unknown as AuthenticatedEntity
    })()

    // Then
    expect(E.isRight(result)).toBe(true)
    expect(mockOrgAdminRepo.listOrganizationAdmins).toHaveBeenCalled()
  })

  it("should deny non-admin from listing organization admins", async () => {
    // When
    const result = await service.listOrganizationAdmins({
      organizationName: "default",
      requestor: {entityType: "user", user: mockMemberUser} as unknown as AuthenticatedEntity
    })()

    // Then
    expect(E.isLeft(result)).toBe(true)
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    expect(result.left).toBe("requestor_not_authorized")
    expect(mockOrgAdminRepo.listOrganizationAdmins).not.toHaveBeenCalled()
  })
})
