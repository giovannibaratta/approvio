import {
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  UnauthorizedException
} from "@nestjs/common"
import {Reflector} from "@nestjs/core"
import {TenantGuard} from "../../src/auth/tenant.guard"
import {getTenantContextFactory} from "../../src/auth/get-tenant-context.decorator"
import {AuthenticatedUser, AuthenticatedAgent, MembershipStatus, OrgRole} from "@domain"
import {IS_PUBLIC_KEY} from "../../src/auth/jwt.authguard"

// TODO: Conver to integration style tests and delete this
describe("TenantGuard", () => {
  let guard: TenantGuard
  let reflector: jest.Mocked<Reflector>

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn()
    } as unknown as jest.Mocked<Reflector>

    guard = new TenantGuard(reflector)
  })

  function createMockExecutionContext(req: {
    path: string
    params?: Record<string, string>
    requestor?: unknown
    tenantContext?: unknown
  }): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({})
      }),
      getHandler: () => ({}),
      getClass: () => ({})
    } as unknown as ExecutionContext
  }

  const mockUser = (organizationId: string): AuthenticatedUser => ({
    entityType: "user",
    user: {
      id: "user-123",
      organizationId,
      accountId: "acc-123",
      displayName: "Test User",
      status: MembershipStatus.ACTIVE,
      orgRole: OrgRole.MEMBER,
      roles: [],
      occ: 1n,
      createdAt: new Date(),
      updatedAt: new Date()
    },
    providerId: "provider-1"
  })

  const mockAgent = (organizationId: string): AuthenticatedAgent => ({
    entityType: "agent",
    agent: {
      id: "agent-123",
      organizationId,
      agentName: "deploy-bot",
      publicKey: "pub-key",
      status: "active",
      roles: [],
      createdAt: new Date(),
      updatedAt: new Date()
    }
  })

  it("should allow public routes without checking tenant context or credentials", () => {
    reflector.getAllAndOverride.mockReturnValue(true)
    const req = {
      path: "/o/org-123/auth/agents/challenge",
      params: {organizationId: "org-123"}
    }
    const context = createMockExecutionContext(req)

    const result = guard.canActivate(context)

    expect(result).toBe(true)
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(IS_PUBLIC_KEY, [expect.any(Object), expect.any(Object)])
  })

  it("should ignore routes without organizationId route parameter", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const req = {
      path: "/spaces",
      params: {}
    }
    const context = createMockExecutionContext(req)

    const result = guard.canActivate(context)

    expect(result).toBe(true)
  })

  it("should ignore routes that do not start with /o/", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const req = {
      path: "/spaces",
      params: {organizationId: "org-123"}
    }
    const context = createMockExecutionContext(req)

    const result = guard.canActivate(context)

    expect(result).toBe(true)
  })

  it("should fail-closed and throw InternalServerErrorException with UNKNOWN error code if /o/ route is missing organizationId parameter", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const loggerSpy = jest.spyOn(Logger, "error").mockImplementation(() => {})
    const req = {
      path: "/o/something/agents",
      params: {}
    }
    const context = createMockExecutionContext(req)

    expect(() => guard.canActivate(context)).toThrow(InternalServerErrorException)
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining("is under /o/ but is missing :organizationId route parameter")
    )
    loggerSpy.mockRestore()
  })

  it("should respect BASE_PREFIX environment variable when normalizing request path", () => {
    process.env.BASE_PREFIX = "/api/v1"
    reflector.getAllAndOverride.mockReturnValue(false)
    const req = {
      path: "/api/v1/o/org-123/agents",
      params: {organizationId: "org-123"},
      requestor: mockUser("org-123")
    }
    const context = createMockExecutionContext(req)

    const result = guard.canActivate(context)

    expect(result).toBe(true)
    delete process.env.BASE_PREFIX
  })

  it("should throw UnauthorizedException if requestor is missing on a protected /o/:organizationId route", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const req = {
      path: "/o/org-123/agents",
      params: {organizationId: "org-123"},
      requestor: undefined
    }
    const context = createMockExecutionContext(req)

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException)
  })


  it("should throw ForbiddenException if user organization does not match route parameter", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const req = {
      path: "/o/org-target/agents",
      params: {organizationId: "org-target"},
      requestor: mockUser("org-different")
    }
    const context = createMockExecutionContext(req)

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException)
  })

  it("should throw ForbiddenException if agent organization does not match route parameter", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const req = {
      path: "/o/org-target/agents",
      params: {organizationId: "org-target"},
      requestor: mockAgent("org-different")
    }
    const context = createMockExecutionContext(req)

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException)
  })

  it("should allow and populate tenantContext on request when user organization matches", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const req: {
      path: string
      params: Record<string, string>
      requestor: AuthenticatedUser
      tenantContext?: {organizationId: string}
    } = {
      path: "/o/org-123/agents",
      params: {organizationId: "org-123"},
      requestor: mockUser("org-123")
    }
    const context = createMockExecutionContext(req)

    const result = guard.canActivate(context)

    expect(result).toBe(true)
    expect(req.tenantContext).toEqual({organizationId: "org-123"})
  })

  it("should allow and populate tenantContext on request when agent organization matches", () => {
    reflector.getAllAndOverride.mockReturnValue(false)
    const req: {
      path: string
      params: Record<string, string>
      requestor: AuthenticatedAgent
      tenantContext?: {organizationId: string}
    } = {
      path: "/o/org-456/agents",
      params: {organizationId: "org-456"},
      requestor: mockAgent("org-456")
    }
    const context = createMockExecutionContext(req)

    const result = guard.canActivate(context)

    expect(result).toBe(true)
    expect(req.tenantContext).toEqual({organizationId: "org-456"})
  })

  describe("getTenantContextFactory", () => {
    it("should extract tenantContext when present on request", () => {
      const req = {
        path: "/o/org-123/agents",
        tenantContext: {organizationId: "org-123"}
      }
      const context = createMockExecutionContext(req)

      const result = getTenantContextFactory(null, context)

      expect(result).toEqual({organizationId: "org-123"})
    })

    it("should throw InternalServerErrorException when tenantContext is missing", () => {
      const req = {
        path: "/o/org-123/agents"
      }
      const context = createMockExecutionContext(req)

      expect(() => getTenantContextFactory(null, context)).toThrow()
    })
  })
})
