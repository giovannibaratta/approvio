import {ConfigProvider} from "@external/config"

const keys = ["DISPATCH_CONCURRENCY_PER_ORGANIZATION", "DISPATCH_LEASE_DURATION_MS"] as const
const original = new Map(keys.map(key => [key, process.env[key]]))

describe("dispatch configuration", () => {
  beforeEach(() => {
    keys.forEach(key => {
      delete process.env[key]
    })
  })
  afterAll(() => {
    keys.forEach(key => {
      const value = original.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    })
  })

  it("defaults to four dispatches per organization with a two-minute lease", () => {
    expect(ConfigProvider.validateDispatchConfig()).toEqual({
      concurrencyPerOrganization: 4,
      leaseDurationMs: 120000
    })
  })
  it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])("rejects invalid capacity %s", value => {
    process.env.DISPATCH_CONCURRENCY_PER_ORGANIZATION = value
    expect(() => ConfigProvider.validateDispatchConfig()).toThrow("must be a positive safe integer")
  })
  it("accepts an explicitly configured cap and lease duration", () => {
    process.env.DISPATCH_CONCURRENCY_PER_ORGANIZATION = "2"
    process.env.DISPATCH_LEASE_DURATION_MS = "1000"
    expect(ConfigProvider.validateDispatchConfig()).toEqual({
      concurrencyPerOrganization: 2,
      leaseDurationMs: 1000
    })
  })
})
