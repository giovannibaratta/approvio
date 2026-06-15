import * as dns from "dns"
import * as http from "http"
import * as https from "https"
import * as ipaddr from "ipaddr.js"
import * as net from "net"
import {SsrfProtectionConfig} from "../config/interfaces"

// Define an error class for SSRF violations (to distinguish from network errors)
export class SsrfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SsrfError"
  }
}

// List of blocked IPv4 CIDR ranges
const BLOCKED_IPV4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16"
].map(cidr => ipaddr.parseCIDR(cidr))

// List of blocked IPv6 CIDR ranges
const BLOCKED_IPV6_CIDRS = ["::1/128", "fc00::/7", "fe80::/10"].map(cidr => ipaddr.parseCIDR(cidr))

/**
 * Type guard to check if an IP address is IPv4.
 */
function isIPv4(ip: ipaddr.IPv4 | ipaddr.IPv6): ip is ipaddr.IPv4 {
  return ip.kind() === "ipv4"
}

/**
 * Type guard to check if an IP address is IPv6.
 */
function isIPv6(ip: ipaddr.IPv4 | ipaddr.IPv6): ip is ipaddr.IPv6 {
  return ip.kind() === "ipv6"
}

/**
 * Parses and normalizes an IP address string, converting IPv4-mapped IPv6 addresses to standard IPv4.
 *
 * @param ipStr - The IP address string to parse.
 * @returns The parsed IP address object, or null if parsing fails.
 */
function parseAndNormalizeIp(ipStr: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    let ip = ipaddr.parse(ipStr)
    if (isIPv6(ip) && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address()
    return ip
  } catch {
    return null
  }
}

/**
 * Checks whether a parsed IP address matches a given CIDR block range.
 *
 * @param ip - The parsed and normalized IPv4 or IPv6 address to check.
 * @param cidrStr - The CIDR string (e.g., "10.0.5.0/24") to match against.
 * @returns true if the IP matches the CIDR range; false otherwise or if the CIDR string is invalid.
 */
function matchesCidr(ip: ipaddr.IPv4 | ipaddr.IPv6, cidrStr: string): boolean {
  try {
    const cidr = ipaddr.parseCIDR(cidrStr)
    if (isIPv4(ip)) return ip.match(cidr)
    return ip.match(cidr)
  } catch {
    return false
  }
}

/**
 * Checks whether a parsed IP address exactly matches a destination IP string.
 *
 * @param ip - The parsed and normalized IPv4 or IPv6 address to check.
 * @param destIpStr - The destination IP address string to match against.
 * @returns true if the IP matches; false otherwise.
 */
function matchesIp(ip: ipaddr.IPv4 | ipaddr.IPv6, destIpStr: string): boolean {
  const destIp = parseAndNormalizeIp(destIpStr)
  if (!destIp) return false
  return ip.toString() === destIp.toString()
}

export function isBlockedIp(address: string): boolean {
  const ip = parseAndNormalizeIp(address)
  if (!ip)
    // If we can't parse the IP, we should fail closed (block it by default) to be safe
    return true

  if (isIPv4(ip)) return BLOCKED_IPV4_CIDRS.some(cidr => ip.match(cidr))

  return BLOCKED_IPV6_CIDRS.some(cidr => ip.match(cidr))
}

/**
 * Checks whether a given hostname or its resolved IP address is allowed based on the
 * configure allowed destinations list (bypassing SSRF checks).
 *
 * Supports three matching strategies:
 * 1. Exact hostname/domain match (case-insensitive, e.g., "internal.example.com").
 * 2. CIDR block range matching (e.g., "10.0.5.0/24" for IP addresses matching the range).
 * 3. Exact IP address match (e.g., matching the resolved IP directly against an allowed IP).
 *
 * @param hostnameOrIp - The requested host name (domain) or IP address to validate.
 * @param allowedDestinations - Array of configured allowed domains, IPs, or CIDR ranges.
 * @returns true if the target is allowed; false otherwise.
 */
export function isAllowedDestination(hostnameOrIp: string, allowedDestinations: string[]): boolean {
  // 1. Exact hostname/domain match (case-insensitive)
  const lowerHostnameOrIp = hostnameOrIp.toLowerCase()
  // 2. IP-based checks (CIDR ranges and exact IP matches)
  const ipToCheck = parseAndNormalizeIp(hostnameOrIp)

  for (const dest of allowedDestinations) {
    if (lowerHostnameOrIp === dest.toLowerCase()) return true
    if (!ipToCheck) continue

    if (dest.includes("/")) {
      if (matchesCidr(ipToCheck, dest)) return true
    } else if (matchesIp(ipToCheck, dest)) return true
  }

  return false
}

/**
 * Creates a custom DNS lookup function that wraps the standard Node.js `dns.lookup`.
 * This custom lookup checks resolved IP addresses against the SSRF blocklist before
 * returning them, protecting the system against DNS rebinding attacks.
 *
 * It supports signature normalization for the lookup callback and options argument.
 *
 * @param config - The SSRF protection configuration (mode and allowed destinations list)
 * @returns A custom LookupFunction compatible with http.Agent/https.Agent options
 */
function createSafeLookup(config: SsrfProtectionConfig): net.LookupFunction {
  return (hostname: string, options: unknown, callback: unknown) => {
    // 1. ARGUMENT NORMALIZATION:
    // Node's dns.lookup supports signature overloads. The callback might be passed
    // as the second argument (options) when no options object is provided.
    let cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void

    // isAll tracks whether the caller expects an array of all resolved addresses (all: true),
    // or just a single primary IP address string (default).
    let isAll = false

    // We always force { all: true } on our internal dns.lookup call. This is a crucial security measure.
    // By resolving all IP addresses mapped to a hostname, we can validate the entire set.
    // This prevents attackers from bypasses where they map a domain to both a public and a private IP.
    let lookupOptions: dns.LookupAllOptions = {all: true}

    if (typeof options === "function") cb = options as typeof cb
    else {
      cb = callback as typeof cb

      if (typeof options === "object" && options !== null) {
        // Record whether the caller explicitly asked for all addresses
        isAll = (options as Record<string, unknown>).all === true

        // Inherit caller's options (like hints/family) but override 'all' to true
        lookupOptions = {
          ...options,
          all: true
        }
      }
    }

    // 2. RAW IP HOSTNAME BYPASS:
    // If the input hostname is already a raw IP (v4 or v6), Node's standard HTTP/HTTPS agents
    // would normally bypass dns.lookup entirely and connect directly. However, if the agent's lookup
    // function IS called directly with an IP, we must intercept it to perform pre-connection SSRF check.
    if (net.isIP(hostname) !== 0) {
      const family = net.isIP(hostname)
      // Format the returned value to match what the caller expects (array vs single string)
      const addressVal: string | dns.LookupAddress[] = isAll ? [{address: hostname, family}] : hostname

      const error = validateHostnameOrIp(hostname, config)
      if (error) {
        process.nextTick(() => cb(error, addressVal, family))
        return
      }

      // If the IP is neither explicitly allowed nor blocked, it is a safe public IP address.
      // Allow the connection to proceed normally.
      process.nextTick(() => cb(null, addressVal, family))
      return
    }

    // 3. DNS RESOLUTION & VALIDATION:
    // Execute the actual DNS lookup, resolving all available IP addresses.
    dns.lookup(hostname, lookupOptions, (err: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => {
      handleDnsResult(err, addresses, hostname, config, isAll, cb)
    })
  }
}

function validateHostnameOrIp(hostnameOrIp: string, config: SsrfProtectionConfig): SsrfError | null {
  if (config.mode === "disabled") return null

  if (config.allowedDestinations?.length && isAllowedDestination(hostnameOrIp, config.allowedDestinations)) return null

  if (isBlockedIp(hostnameOrIp))
    return new SsrfError(`Blocked request to ${hostnameOrIp}: resolved to private/reserved IP ${hostnameOrIp}`)

  return null
}

function handleDnsResult(
  err: NodeJS.ErrnoException | null,
  addresses: dns.LookupAddress[],
  hostname: string,
  config: SsrfProtectionConfig,
  isAll: boolean,
  cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void
): void {
  if (err) {
    // If DNS lookup fails, let the error propagate normally so the caller knows it failed.
    cb(err, isAll ? [] : "", undefined)
    return
  }

  // If addresses is null, undefined, or empty, handle it immediately.
  // This guarantees that if we proceed, addresses[0] is always defined.
  const firstAddress = addresses[0]

  if (!addresses || addresses.length === 0 || !firstAddress) {
    cb(null, isAll ? [] : "", undefined)
    return
  }

  const addressVal = isAll ? addresses : firstAddress.address
  const familyVal = isAll ? undefined : firstAddress.family

  if (config.mode === "disabled") {
    // If SSRF protection is disabled, skip checks and return results in caller's expected format.
    cb(null, addressVal, familyVal)
    return
  }

  // Defense-in-depth: limit maximum resolved IPs to prevent DNS inflation / DoS attacks.
  if (addresses.length > 20) {
    cb(
      new SsrfError(`Blocked request to ${hostname}: too many resolved IP addresses (${addresses.length})`),
      addressVal,
      familyVal
    )
    return
  }

  // Check if the hostname (domain string) is explicitly allowed.
  // If the domain is allowed, we bypass IP checking entirely for efficiency.
  if (config.allowedDestinations?.length && isAllowedDestination(hostname, config.allowedDestinations)) {
    cb(null, addressVal, familyVal)
    return
  }

  // Validate every resolved IP address
  for (const addr of addresses) {
    const ip = addr.address

    // Check if the resolved IP address matches any allowed destination/CIDR range
    if (config.allowedDestinations?.length && isAllowedDestination(ip, config.allowedDestinations)) continue

    // If the resolved IP is blocked (e.g. is private/reserved), block the entire request
    if (isBlockedIp(ip)) {
      cb(new SsrfError(`Blocked request to ${hostname}: resolved to private/reserved IP ${ip}`), addressVal, familyVal)
      return
    }
  }

  // If all resolved IPs are safe and/or allowed, return the result in caller's expected format
  cb(null, addressVal, familyVal)
}

export function createSsrfSafeAgents(config: SsrfProtectionConfig): {httpAgent: http.Agent; httpsAgent: https.Agent} {
  const lookup = createSafeLookup(config)

  return {
    httpAgent: new http.Agent({lookup}),
    httpsAgent: new https.Agent({lookup})
  }
}
