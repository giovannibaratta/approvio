import {OutboxPublicationStateFactory} from "@domain"

describe("OutboxPublicationStateFactory", () => {
  const publishedAt = new Date("2026-01-01T12:00:00Z")
  const expiresAt = new Date("2026-01-01T11:00:00Z")

  it.each([
    {
      name: "pending",
      input: {publishedAt: null, leaseOwner: null, leaseUntil: null},
      expected: {state: "pending"}
    },
    {
      name: "published",
      input: {publishedAt, leaseOwner: null, leaseUntil: null},
      expected: {state: "published", publishedAt}
    },
    {
      name: "leased, including an expired lease",
      input: {publishedAt: null, leaseOwner: "worker", leaseUntil: expiresAt},
      expected: {state: "leased", owner: "worker", expiresAt}
    }
  ])("classifies $name publication data", ({input, expected}) => {
    // When
    const result = OutboxPublicationStateFactory.validate(input)
    // Expect
    expect(result).toBeRightOf(expected)
  })

  it.each([
    {name: "null input", input: null},
    {name: "missing fields", input: {}},
    {name: "missing lease expiry", input: {publishedAt: null, leaseOwner: "worker", leaseUntil: null}},
    {name: "missing lease owner", input: {publishedAt: null, leaseOwner: null, leaseUntil: expiresAt}},
    {name: "empty lease owner", input: {publishedAt: null, leaseOwner: " ", leaseUntil: expiresAt}},
    {name: "non-string lease owner", input: {publishedAt: null, leaseOwner: 1, leaseUntil: expiresAt}},
    {name: "published event with a lease", input: {publishedAt, leaseOwner: "worker", leaseUntil: expiresAt}},
    {name: "invalid publication date", input: {publishedAt: new Date(NaN), leaseOwner: null, leaseUntil: null}},
    {
      name: "serialized publication date",
      input: {publishedAt: publishedAt.toISOString(), leaseOwner: null, leaseUntil: null}
    },
    {name: "invalid lease expiry", input: {publishedAt: null, leaseOwner: "worker", leaseUntil: new Date(NaN)}},
    {
      name: "serialized lease expiry",
      input: {publishedAt: null, leaseOwner: "worker", leaseUntil: expiresAt.toISOString()}
    }
  ])("rejects $name", ({input}) => {
    // When
    const result = OutboxPublicationStateFactory.validate(input)
    // Expect
    expect(result).toBeLeftOf("outbox_publication_state_invalid")
  })
})
