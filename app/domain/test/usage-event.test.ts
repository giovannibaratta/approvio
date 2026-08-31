import {UsageEventFactory, CreateUsageEvent, UsageMetric} from "../src/usage-event"
import {ActorType} from "../src/audit-log"
import {v7 as uuidv7} from "uuid"
import {unwrapRight} from "@utils/either"

describe("UsageEventFactory", () => {
  const validData: CreateUsageEvent = {
    entityType: "organization",
    entityId: uuidv7(),
    actor: {id: uuidv7(), type: "user"},
    metric: "MAX_LLM_TOKENS_PER_MONTH",
    quantity: 1000n,
    isBillable: true,
    occurredAt: new Date(),
    metadata: {provider: "openai"}
  }

  describe("create", () => {
    it("should successfully create a valid usage event with generated id and default date if not provided", () => {
      // Given
      const {occurredAt: _occurredAt, ...withoutDate} = validData

      // When
      const result = UsageEventFactory.create(withoutDate)

      // Expect
      expect(result).toBeRight()
      const event = unwrapRight(result)
      expect(event.id).toBeDefined()
      expect(typeof event.id).toBe("string")
      expect(event.occurredAt).toBeInstanceOf(Date)
      expect(event.metric).toBe("MAX_LLM_TOKENS_PER_MONTH")
      expect(event.quantity).toBe(1000n)
    })

    it("should use provided occurredAt date when passed to create", () => {
      // Given
      const date = new Date("2025-01-01T00:00:00.000Z")

      // When
      const result = UsageEventFactory.create({...validData, occurredAt: date})

      // Expect
      expect(result).toBeRight()
      const event = unwrapRight(result)
      expect(event.occurredAt).toEqual(date)
    })
  })

  describe("validate", () => {
    it("should successfully validate a complete valid UsageEvent object", () => {
      // Given
      const event = {
        id: uuidv7(),
        ...validData
      }

      // When
      const result = UsageEventFactory.validate(event)

      // Expect
      expect(result).toBeRight()
    })

    it("should return usage_event_malformed_object for non-object data", () => {
      // Given
      const nullData = null
      const stringData = "invalid"
      const numberData = 123

      // When
      const nullResult = UsageEventFactory.validate(nullData)
      const stringResult = UsageEventFactory.validate(stringData)
      const numberResult = UsageEventFactory.validate(numberData)

      // Expect
      expect(nullResult).toBeLeftOf("usage_event_malformed_object")
      expect(stringResult).toBeLeftOf("usage_event_malformed_object")
      expect(numberResult).toBeLeftOf("usage_event_malformed_object")
    })

    it("should return usage_event_missing_required_fields if required fields are absent or invalid", () => {
      // Given
      const event = {id: uuidv7(), ...validData}
      const missingId = {...event, id: ""}
      const missingOccurredAt = {...event, occurredAt: "invalid-date"}
      const invalidBillable = {...event, isBillable: "true"}

      // When
      const missingIdResult = UsageEventFactory.validate(missingId)
      const missingOccurredAtResult = UsageEventFactory.validate(missingOccurredAt)
      const invalidBillableResult = UsageEventFactory.validate(invalidBillable)

      // Expect
      expect(missingIdResult).toBeLeftOf("usage_event_missing_required_fields")
      expect(missingOccurredAtResult).toBeLeftOf("usage_event_missing_required_fields")
      expect(invalidBillableResult).toBeLeftOf("usage_event_missing_required_fields")
    })

    it("should return usage_event_invalid_entity_type if entityType is empty or not string", () => {
      // Given
      const event = {id: uuidv7(), ...validData, entityType: "   "}

      // When
      const result = UsageEventFactory.validate(event)

      // Expect
      expect(result).toBeLeftOf("usage_event_invalid_entity_type")
    })

    it("should return usage_event_invalid_actor_type if actor type is not user or agent", () => {
      // Given
      const event = {
        id: uuidv7(),
        ...validData,
        actor: {id: uuidv7(), type: "system" as unknown as ActorType}
      }

      // When
      const result = UsageEventFactory.validate(event)

      // Expect
      expect(result).toBeLeftOf("usage_event_invalid_actor_type")
    })

    it("should return usage_event_invalid_metric if metric is not a supported metered quota", () => {
      // Given
      const event = {
        id: uuidv7(),
        ...validData,
        metric: "INVALID_METRIC" as unknown as UsageMetric
      }

      // When
      const result = UsageEventFactory.validate(event)

      // Expect
      expect(result).toBeLeftOf("usage_event_invalid_metric")
    })

    it("should return usage_event_invalid_quantity if quantity is negative or not bigint", () => {
      // Given
      const negativeQuantity = {
        id: uuidv7(),
        ...validData,
        quantity: -5n
      }
      const numberQuantity = {
        id: uuidv7(),
        ...validData,
        quantity: 100 as unknown as bigint
      }

      // When
      const negativeResult = UsageEventFactory.validate(negativeQuantity)
      const numberResult = UsageEventFactory.validate(numberQuantity)

      // Expect
      expect(negativeResult).toBeLeftOf("usage_event_invalid_quantity")
      expect(numberResult).toBeLeftOf("usage_event_invalid_quantity")
    })

    it("should return usage_event_malformed_object if metadata is provided but not an object", () => {
      // Given
      const event = {
        id: uuidv7(),
        ...validData,
        metadata: "invalid-metadata" as unknown as Record<string, unknown>
      }

      // When
      const result = UsageEventFactory.validate(event)

      // Expect
      expect(result).toBeLeftOf("usage_event_malformed_object")
    })
  })
})
