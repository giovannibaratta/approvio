import {OrganizationAdminRepository, PaginatedOrganizationAdminsList} from "./interfaces"
import {OrganizationAdminService, ListOrganizationAdminsRequest} from "./organization-admin.service"
import {Test, TestingModule} from "@nestjs/testing"
import {ORGANIZATION_ADMIN_REPOSITORY_TOKEN} from "./interfaces"
import {UserFactory, AuthenticatedEntity} from "@domain"
import * as TE from "fp-ts/TaskEither"
import * as E from "fp-ts/Either"

describe("OrganizationAdminService", () => {
  let service: OrganizationAdminService
  let repository: OrganizationAdminRepository

  beforeEach(async () => {
    repository = {
      createOrganizationAdmin: jest.fn(),
      listOrganizationAdmins: jest.fn(),
      removeOrganizationAdminIfNotLast: jest.fn(),
      removeOrganizationAdminByEmailIfNotLast: jest.fn()
    }
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationAdminService,
        {
          provide: ORGANIZATION_ADMIN_REPOSITORY_TOKEN,
          useValue: repository
        }
      ]
    }).compile()

    service = module.get<OrganizationAdminService>(OrganizationAdminService)
  })

  it("should fail to list admins if requestor is not an admin", async () => {
    // Given
    const nonAdminUserOrError = UserFactory.newUser({
      email: "user@example.com",
      displayName: "User",
      orgRole: "member" // Not admin
    })

    if (E.isLeft(nonAdminUserOrError)) throw new Error("Failed to create non-admin user")
    const nonAdminUser = nonAdminUserOrError.right

    const requestor: AuthenticatedEntity = {
      entityType: "user",
      user: {
        ...nonAdminUser,
        occ: 1n
      }
    }

    const mockList: PaginatedOrganizationAdminsList = {
      admins: [],
      page: 1,
      limit: 10,
      total: 0
    }
    ;(repository.listOrganizationAdmins as jest.Mock).mockReturnValue(TE.right(mockList))

    // When
    const request: ListOrganizationAdminsRequest = {
      organizationName: "default",
      page: 1,
      limit: 10,
      requestor: requestor
    }
    const result = await service.listOrganizationAdmins(request)()

    // Expect
    expect(result).toEqual(E.left("requestor_not_authorized"))
  })

  it("should list admins if requestor is an admin", async () => {
    // Given
    const adminUserOrError = UserFactory.newUser({
      email: "admin@example.com",
      displayName: "Admin",
      orgRole: "admin"
    })

    if (E.isLeft(adminUserOrError)) throw new Error("Failed to create admin user")
    const adminUser = adminUserOrError.right

    const requestor: AuthenticatedEntity = {
      entityType: "user",
      user: {
        ...adminUser,
        occ: 1n
      }
    }

    const mockList: PaginatedOrganizationAdminsList = {
      admins: [],
      page: 1,
      limit: 10,
      total: 0
    }

    ;(repository.listOrganizationAdmins as jest.Mock).mockReturnValue(TE.right(mockList))

    // When
    const request: ListOrganizationAdminsRequest = {
      organizationName: "default",
      page: 1,
      limit: 10,
      requestor: requestor
    }
    const result = await service.listOrganizationAdmins(request)()

    // Expect
    expect(result).toEqual(E.right(mockList))
  })
})
