import {createHmac, timingSafeEqual} from "crypto"
import * as E from "fp-ts/Either"

const ETAG_PREFIX = "v1"

/**
 * Creates an opaque, tenant- and resource-bound entity tag. The version is never
 * sent in clear text and a tag cannot be replayed for another resource.
 */
export function createEntityTag(secret: string, organizationId: string, resourceId: string, version: bigint): string {
  const payload = `${ETAG_PREFIX}.${organizationId}.${resourceId}.${version.toString()}`
  const signature = createHmac("sha256", secret).update(payload).digest("base64url")
  return `"${Buffer.from(`${payload}.${signature}`, "utf8").toString("base64url")}"`
}

export function parseEntityTag(
  secret: string,
  organizationId: string,
  resourceId: string,
  tag: string | undefined
): E.Either<"invalid_etag", bigint> {
  if (!tag || !tag.startsWith('"') || !tag.endsWith('"')) return E.left("invalid_etag")

  try {
    const decoded = Buffer.from(tag.slice(1, -1), "base64url").toString("utf8")
    const [prefix, tagOrganizationId, tagResourceId, versionText, signature, ...rest] = decoded.split(".")
    if (
      prefix !== ETAG_PREFIX ||
      tagOrganizationId !== organizationId ||
      tagResourceId !== resourceId ||
      !versionText ||
      !signature ||
      rest.length !== 0 ||
      !/^-?(0|[1-9][0-9]*)$/.test(versionText)
    )
      return E.left("invalid_etag")

    const payload = `${prefix}.${tagOrganizationId}.${tagResourceId}.${versionText}`
    const expected = createHmac("sha256", secret).update(payload).digest()
    const actual = Buffer.from(signature, "base64url")
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return E.left("invalid_etag")

    return E.right(BigInt(versionText))
  } catch {
    return E.left("invalid_etag")
  }
}

/**
 * Session tags keep the account/session binding explicit at call sites while reusing the same
 * HMAC format as resource tags. A resource tag must never be accepted for a session CAS update.
 */
export function createSessionTag(secret: string, accountId: string, sessionId: string, version: bigint): string {
  return createEntityTag(secret, accountId, sessionId, version)
}

export function parseSessionTag(
  secret: string,
  accountId: string,
  sessionId: string,
  tag: string | undefined
): E.Either<"invalid_etag", bigint> {
  return parseEntityTag(secret, accountId, sessionId, tag)
}
