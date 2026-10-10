import {LeaseFactory} from "@domain"
import {
  DispatchAttemptFactory,
  DispatchTransitionFactory,
  DispatchWorkFactory
} from "@services/durable-work/dispatch.models"
import {DispatchCompletionFactory} from "@services/durable-work/models"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

const now = new Date("2026-10-10T12:00:00Z")
const work = {
  id: uuidv7(),
  kind: "webhook",
  state: "claimed",
  fencing: 1n,
  occ: 0n,
  attempts: 1,
  lease: {owner: uuidv7(), expiresAt: new Date(now.getTime() + 1000)}
}
const attempt = {id: uuidv7(), taskId: work.id, state: "admitted", fencing: 1n, occ: 0n, admittedAt: now}
const lease = unwrapRight(
  LeaseFactory.validate({owner: work.lease.owner, fencing: 1n, expiresAt: work.lease.expiresAt})
)

describe("Dispatch model error distinctions", () => {
  beforeEach(() => jest.useFakeTimers({now}))
  afterEach(() => jest.useRealTimers())

  it("propagates validation failure instead of branding an invalid new attempt", () => {
    // Given
    const ready = unwrapRight(DispatchWorkFactory.validate({...work, state: "ready", lease: undefined}))
    // When
    const result = DispatchTransitionFactory.claim(ready, work.lease.owner, now, work.lease.expiresAt, "invalid")
    // Expect
    expect(result).toBeLeftOf("dispatch_attempt_invalid_id")
    expect(ready.state).toBe("ready")
    expect(ready.occ).toBe(work.occ)
    expect(ready.attempts).toBe(work.attempts)
  })

  it("returns resulting models for claim, execution and retry completion without changing the inputs", () => {
    // Given
    const ready = unwrapRight(DispatchWorkFactory.validate({...work, state: "ready", lease: undefined}))
    const attemptId = uuidv7()
    const expiresAt = work.lease.expiresAt
    // When
    const claimed = unwrapRight(DispatchTransitionFactory.claim(ready, work.lease.owner, now, expiresAt, attemptId))
    const admitted = unwrapRight(DispatchAttemptFactory.validate(claimed.attempt))
    const executingAt = new Date(now.getTime() + 100)
    jest.setSystemTime(executingAt)
    const executing = unwrapRight(
      DispatchTransitionFactory.startExecution(claimed.work, admitted, {
        ...lease,
        fencing: claimed.work.fencing
      })
    )
    const executingAttempt = unwrapRight(DispatchAttemptFactory.validate(executing.attempt))
    const completedAt = new Date(now.getTime() + 200)
    const completion = unwrapRight(
      DispatchCompletionFactory.validate({
        state: "retry_due",
        outcome: {type: "http_response", statusCode: 503}
      })
    )
    jest.setSystemTime(completedAt)
    const completed = unwrapRight(
      DispatchTransitionFactory.complete(
        executing.work,
        executingAttempt,
        {
          ...lease,
          fencing: executing.work.fencing
        },
        completion
      )
    )
    // Expect
    expect(claimed.work).toEqual({
      ...ready,
      state: "claimed",
      lease: work.lease,
      fencing: ready.fencing + 1n,
      occ: ready.occ + 1n,
      attempts: ready.attempts + 1
    })
    expect(admitted).toMatchObject({
      id: attemptId,
      taskId: ready.id,
      state: "admitted",
      fencing: claimed.work.fencing,
      occ: 0n,
      admittedAt: now
    })
    expect(executing.work).toEqual({...claimed.work, state: "executing", occ: claimed.work.occ + 1n})
    expect(executingAttempt).toEqual({...admitted, state: "executing", executingAt, occ: 1n})
    expect(completed.work).toEqual({
      ...executing.work,
      state: "retry_due",
      lease: undefined,
      occ: executing.work.occ + 1n
    })
    expect(completed.attempt).toEqual({
      ...executingAttempt,
      state: "retry_due",
      completedAt,
      outcomeCategory: "http_503",
      occ: 2n
    })
    expect(ready.state).toBe("ready")
    expect(ready.lease).toBeUndefined()
    expect(claimed.work.state).toBe("claimed")
    expect(admitted).not.toHaveProperty("executingAt")
    expect(executingAttempt).not.toHaveProperty("completedAt")
  })

  it.each(["claimed", "executing"])("returns concrete recovery models for abandoned %s work", state => {
    // Given
    const expired = unwrapRight(
      DispatchWorkFactory.validate({...work, state, lease: {...work.lease, expiresAt: new Date(0)}})
    )
    const current = unwrapRight(
      DispatchAttemptFactory.validate({
        ...attempt,
        state: state === "claimed" ? "admitted" : "executing",
        ...(state === "claimed" ? {} : {executingAt: now})
      })
    )
    // When
    const recovered = unwrapRight(DispatchTransitionFactory.recover(expired, current, now))
    // Expect
    expect(recovered.work).toEqual({
      ...expired,
      state: state === "claimed" ? "retry_due" : "unknown",
      lease: undefined,
      fencing: expired.fencing + 1n,
      occ: expired.occ + 1n
    })
    expect(recovered.attempt).toEqual({
      ...current,
      state: state === "claimed" ? "failed" : "unknown",
      completedAt: now,
      outcomeCategory: "lease_expired",
      occ: current.occ + 1n
    })
    expect(expired.lease).toBeDefined()
    expect(current).not.toHaveProperty("completedAt")
  })

  it("returns paused work and closes an admitted attempt without advancing its fence or count", () => {
    // Given
    const currentWork = unwrapRight(DispatchWorkFactory.validate(work))
    const currentAttempt = unwrapRight(DispatchAttemptFactory.validate(attempt))
    // When
    const paused = unwrapRight(DispatchTransitionFactory.pauseAttempt(currentWork, currentAttempt, lease))
    // Expect
    expect(paused.work).toEqual({...currentWork, state: "paused", lease: undefined, occ: currentWork.occ + 1n})
    expect(paused.attempt).toEqual({
      ...currentAttempt,
      state: "failed",
      completedAt: now,
      outcomeCategory: "organization_paused",
      occ: currentAttempt.occ + 1n
    })
  })

  it("requires execution metadata and rejects completion metadata while executing", () => {
    // Given
    const executing = {...attempt, state: "executing", executingAt: now}
    // When / Expect
    expect(DispatchAttemptFactory.validate({...attempt, state: "executing"})).toBeLeftOf(
      "dispatch_attempt_invalid_executing_at"
    )
    expect(DispatchAttemptFactory.validate({...executing, completedAt: now})).toBeLeftOf(
      "dispatch_attempt_invalid_completed_at"
    )
    expect(DispatchAttemptFactory.validate({...executing, outcomeCategory: "delivered"})).toBeLeftOf(
      "dispatch_attempt_invalid_outcome_category"
    )
    expect(DispatchAttemptFactory.validate(executing)).toBeRight()
  })

  it.each(["succeeded", "retry_due", "unknown"])("requires execution, completion and outcome for %s", state => {
    // Given
    const completed = {...attempt, state, executingAt: now, completedAt: now, outcomeCategory: "delivered"}
    // When / Expect
    expect(DispatchAttemptFactory.validate({...completed, executingAt: undefined})).toBeLeftOf(
      "dispatch_attempt_invalid_executing_at"
    )
    expect(DispatchAttemptFactory.validate({...completed, completedAt: undefined})).toBeLeftOf(
      "dispatch_attempt_invalid_completed_at"
    )
    expect(DispatchAttemptFactory.validate({...completed, outcomeCategory: undefined})).toBeLeftOf(
      "dispatch_attempt_invalid_outcome_category"
    )
    expect(DispatchAttemptFactory.validate(completed)).toBeRight()
  })

  it("allows failure before or after execution but always requires completion and an outcome", () => {
    // Given
    const failed = {...attempt, state: "failed", completedAt: now, outcomeCategory: "organization_paused"}
    // When / Expect
    expect(DispatchAttemptFactory.validate({...failed, completedAt: undefined})).toBeLeftOf(
      "dispatch_attempt_invalid_completed_at"
    )
    expect(DispatchAttemptFactory.validate({...failed, outcomeCategory: undefined})).toBeLeftOf(
      "dispatch_attempt_invalid_outcome_category"
    )
    expect(DispatchAttemptFactory.validate(failed)).toBeRight()
    expect(DispatchAttemptFactory.validate({...failed, executingAt: now})).toBeRight()
    const beforeExecution = unwrapRight(DispatchAttemptFactory.validate(failed))
    expect(beforeExecution).not.toHaveProperty("executingAt")
  })

  it.each([0n, -1n])("accepts signed OCC and fencing values %s", value => {
    // When
    const workResult = DispatchWorkFactory.validate({...work, occ: value, fencing: value})
    const attemptResult = DispatchAttemptFactory.validate({...attempt, occ: value, fencing: value})
    const leaseResult = LeaseFactory.validate({...work.lease, fencing: value})
    // Expect
    expect(workResult).toBeRight()
    expect(attemptResult).toBeRight()
    expect(leaseResult).toBeRight()
  })

  it("accepts an absent lease and preserves a complete lease", () => {
    // Given
    const unowned = {...work, state: "ready", lease: undefined}
    // When
    const ownedSnapshot = unwrapRight(DispatchWorkFactory.validate(work))
    const unownedSnapshot = unwrapRight(DispatchWorkFactory.validate(unowned))
    // Expect
    expect(ownedSnapshot.lease).toEqual(work.lease)
    expect(unownedSnapshot.lease).toBeUndefined()
  })

  it.each<[unknown, string]>([
    [undefined, "dispatch_work_malformed_object"],
    [{...work, id: "invalid"}, "dispatch_work_invalid_id"],
    [{...work, kind: "invalid"}, "dispatch_work_invalid_kind"],
    [{...work, state: "invalid"}, "dispatch_work_invalid_state"],
    [{...work, fencing: "invalid"}, "dispatch_work_invalid_fencing"],
    [{...work, occ: "invalid"}, "dispatch_work_invalid_occ"],
    [{...work, attempts: "invalid"}, "dispatch_work_invalid_attempts"],
    [{...work, lease: {...work.lease, owner: 1}}, "dispatch_work_invalid_lease_owner"],
    [{...work, lease: {...work.lease, expiresAt: "invalid"}}, "dispatch_work_invalid_lease_until"],
    [{...work, lease: null}, "dispatch_work_invalid_lease"],
    [{...work, lease: {expiresAt: work.lease.expiresAt}}, "dispatch_work_invalid_lease_owner"],
    [{...work, lease: {owner: work.lease.owner}}, "dispatch_work_invalid_lease_until"]
  ])("preserves the work validation cause %#", (input, error) => {
    // When
    const result = DispatchWorkFactory.validate(input)
    // Expect
    expect(result).toBeLeftOf(error)
  })

  it.each<[unknown, string]>([
    [undefined, "dispatch_attempt_malformed_object"],
    [{...attempt, id: "invalid"}, "dispatch_attempt_invalid_id"],
    [{...attempt, taskId: "invalid"}, "dispatch_attempt_invalid_task_id"],
    [{...attempt, state: "invalid"}, "dispatch_attempt_invalid_state"],
    [{...attempt, fencing: "invalid"}, "dispatch_attempt_invalid_fencing"],
    [{...attempt, occ: "invalid"}, "dispatch_attempt_invalid_occ"],
    [{...attempt, admittedAt: undefined}, "dispatch_attempt_invalid_admitted_at"],
    [{...attempt, executingAt: "invalid"}, "dispatch_attempt_invalid_executing_at"],
    [{...attempt, completedAt: "invalid"}, "dispatch_attempt_invalid_completed_at"],
    [{...attempt, outcomeCategory: 1}, "dispatch_attempt_invalid_outcome_category"]
  ])("preserves the attempt validation cause %#", (input, error) => {
    // When
    const result = DispatchAttemptFactory.validate(input)
    // Expect
    expect(result).toBeLeftOf(error)
  })

  it("distinguishes stale ownership, source state, attempt state and identity", () => {
    // Given
    const snapshot = unwrapRight(DispatchAttemptFactory.validate(attempt))
    const validWork = unwrapRight(DispatchWorkFactory.validate(work))
    const expired = unwrapRight(DispatchWorkFactory.validate({...work, lease: {...work.lease, expiresAt: new Date(0)}}))
    const wrongState = unwrapRight(DispatchWorkFactory.validate({...work, state: "executing"}))
    const completed = unwrapRight(
      DispatchAttemptFactory.validate({
        ...attempt,
        state: "succeeded",
        executingAt: now,
        completedAt: now,
        outcomeCategory: "delivered"
      })
    )
    const unrelated = unwrapRight(DispatchAttemptFactory.validate({...attempt, taskId: uuidv7()}))
    // When / Expect
    expect(DispatchTransitionFactory.startExecution(expired, snapshot, lease)).toBeLeftOf("lease_lost")
    expect(DispatchTransitionFactory.startExecution(wrongState, snapshot, lease)).toBeLeftOf(
      "dispatch_invalid_source_state"
    )
    expect(DispatchTransitionFactory.startExecution(validWork, completed, lease)).toBeLeftOf(
      "dispatch_invalid_attempt_state"
    )
    expect(DispatchTransitionFactory.startExecution(validWork, unrelated, lease)).toBeLeftOf(
      "dispatch_attempt_mismatch"
    )
    expect(DispatchTransitionFactory.startExecution(validWork, snapshot, lease)).toBeRight()
  })

  it("distinguishes an invalid early completion from a lost lease", () => {
    // Given
    const snapshot = unwrapRight(DispatchAttemptFactory.validate(attempt))
    const validWork = unwrapRight(DispatchWorkFactory.validate(work))
    const completion = unwrapRight(
      DispatchCompletionFactory.validate({state: "succeeded", outcome: {type: "delivered"}})
    )
    // When
    const result = DispatchTransitionFactory.complete(validWork, snapshot, lease, completion)
    // Expect
    expect(result).toBeLeftOf("dispatch_invalid_completion")
  })

  it("distinguishes a live recovery lease from inconsistent recovery snapshots", () => {
    // Given
    const snapshot = unwrapRight(DispatchAttemptFactory.validate(attempt))
    const validWork = unwrapRight(DispatchWorkFactory.validate(work))
    const expired = unwrapRight(DispatchWorkFactory.validate({...work, lease: {...work.lease, expiresAt: new Date(0)}}))
    const unrelated = unwrapRight(DispatchAttemptFactory.validate({...attempt, taskId: uuidv7()}))
    const completed = unwrapRight(
      DispatchAttemptFactory.validate({
        ...attempt,
        state: "succeeded",
        executingAt: now,
        completedAt: now,
        outcomeCategory: "delivered"
      })
    )
    // When / Expect
    expect(DispatchTransitionFactory.recover(validWork, snapshot, now)).toBeLeftOf("dispatch_lease_not_expired")
    expect(DispatchTransitionFactory.recover(expired, unrelated, now)).toBeLeftOf("dispatch_attempt_mismatch")
    expect(DispatchTransitionFactory.recover(expired, completed, now)).toBeLeftOf("dispatch_invalid_attempt_state")
    expect(DispatchTransitionFactory.recover(expired, snapshot, now)).toBeRight()
  })
})
