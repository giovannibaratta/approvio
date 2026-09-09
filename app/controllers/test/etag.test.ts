// TODO: We have assertion helpers for right and left values. Use them
import {createEntityTag, createSessionTag, parseEntityTag, parseSessionTag} from "../src/etag"

describe("entity tags", () => {
  const secret = "test-secret"
  const organizationId = "019c6e27-e55b-73d1-87d8-4e01f1f75043"
  const resourceId = "019c7714-3b77-74d1-9866-e1f484aae2ab"

  it("round-trips a signed resource version", () => {
    const tag = createEntityTag(secret, organizationId, resourceId, 42n)

    expect(parseEntityTag(secret, organizationId, resourceId, tag)).toEqual({
      _tag: "Right",
      right: 42n
    })
  })

  it("rejects a tag replayed for another tenant or resource", () => {
    const tag = createEntityTag(secret, organizationId, resourceId, 42n)

    expect(parseEntityTag(secret, organizationId, "019c8a25-7982-7d2a-b039-f0b8750e1e2c", tag)).toEqual({
      _tag: "Left",
      left: "invalid_etag"
    })
  })

  it("rejects an unsigned tag", () => {
    expect(parseEntityTag(secret, organizationId, resourceId, '"v1"')).toEqual({
      _tag: "Left",
      left: "invalid_etag"
    })
  })

  // TODO: The left says invalid_etag. This is a bit misleading
  it("rejects a session tag replayed by another account or session", () => {
    const accountId = "019c6e27-e55b-73d1-87d8-4e01f1f75043"
    const sessionId = "019c7714-3b77-74d1-9866-e1f484aae2ab"
    const tag = createSessionTag(secret, accountId, sessionId, 7n)

    expect(parseSessionTag(secret, accountId, "019c8a25-7982-7d2a-b039-f0b8750e1e2c", tag)).toEqual({
      _tag: "Left",
      left: "invalid_etag"
    })
    expect(parseSessionTag(secret, "019c8a25-7982-7d2a-b039-f0b8750e1e2c", sessionId, tag)).toEqual({
      _tag: "Left",
      left: "invalid_etag"
    })
  })
})
