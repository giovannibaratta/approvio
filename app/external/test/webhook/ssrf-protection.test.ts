import {isBlockedIp, isAllowedDestination} from "../../src/webhook/ssrf-protection"

describe("SSRF Protection", () => {
  describe("isBlockedIp", () => {
    it("should block localhost and private IPs", () => {
      expect(isBlockedIp("127.0.0.1")).toBe(true)
      expect(isBlockedIp("10.0.0.1")).toBe(true)
      expect(isBlockedIp("172.16.0.1")).toBe(true)
      expect(isBlockedIp("192.168.1.1")).toBe(true)
      expect(isBlockedIp("169.254.169.254")).toBe(true)
      expect(isBlockedIp("0.0.0.0")).toBe(true)
      expect(isBlockedIp("100.64.0.1")).toBe(true)
    })

    it("should block IPv6 equivalents and IPv4-mapped IPv6", () => {
      expect(isBlockedIp("::1")).toBe(true)
      expect(isBlockedIp("fc00::1")).toBe(true)
      expect(isBlockedIp("fe80::1")).toBe(true)
      expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true)
    })

    it("should allow public IPs", () => {
      expect(isBlockedIp("8.8.8.8")).toBe(false)
      expect(isBlockedIp("1.1.1.1")).toBe(false)
      expect(isBlockedIp("203.0.113.1")).toBe(false)
      expect(isBlockedIp("::ffff:8.8.8.8")).toBe(false)
    })
  })

  describe("isAllowedDestination", () => {
    it("should match exact hostname", () => {
      expect(isAllowedDestination("internal.example.com", ["internal.example.com"])).toBe(true)
      expect(isAllowedDestination("internal.example.com", ["10.0.5.0/24", "internal.example.com"])).toBe(true)
      expect(isAllowedDestination("other.example.com", ["internal.example.com"])).toBe(false)
    })

    it("should match CIDR ranges", () => {
      expect(isAllowedDestination("10.0.5.100", ["10.0.5.0/24"])).toBe(true)
      expect(isAllowedDestination("10.0.6.100", ["10.0.5.0/24"])).toBe(false)
    })

    it("should handle exact IPs", () => {
      expect(isAllowedDestination("192.168.1.5", ["192.168.1.5"])).toBe(true)
      expect(isAllowedDestination("192.168.1.5", ["192.168.1.6"])).toBe(false)
    })

    it("should handle raw IP hostnames", () => {
      expect(isAllowedDestination("192.168.1.5", ["192.168.1.5"])).toBe(true)
      expect(isAllowedDestination("192.168.1.5", ["192.168.1.0/24"])).toBe(true)
      expect(isAllowedDestination("192.168.1.5", ["192.168.2.0/24"])).toBe(false)
    })

    it("should return false when hostnameOrIp is a domain and we match against CIDR ranges", () => {
      expect(isAllowedDestination("internal.example.com", ["10.0.5.0/24"])).toBe(false)
    })
  })
})
