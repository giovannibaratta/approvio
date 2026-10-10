import {LeaseFactory} from "@domain"
import * as O from "fp-ts/Option"
import * as TE from "fp-ts/TaskEither"
import {DispatchService} from "@services/durable-work/dispatch.service"
import {DispatchRepository} from "@services/durable-work/interfaces"
import {DispatchWorkFactory, DispatchAttemptFactory} from "@services/durable-work/dispatch.models"
import {DispatchCompletionFactory} from "@services/durable-work/models"
import {TenantTransactionManager} from "@services/transaction/interfaces"
import {randomOrgId} from "@test/organization-id"
import {unwrapRight} from "@utils/either"
import {v7 as uuidv7} from "uuid"

function fixture() {
  const context = {organizationId: randomOrgId()}
  const work = unwrapRight(
    DispatchWorkFactory.validate({
      id: uuidv7(),
      kind: "email",
      state: "ready",
      fencing: 0n,
      occ: 0n,
      attempts: 0
    })
  )
  const repository = {
    getWork: jest.fn<ReturnType<DispatchRepository["getWork"]>, Parameters<DispatchRepository["getWork"]>>(() =>
      TE.right(work)
    ),
    getAttempt: jest.fn<ReturnType<DispatchRepository["getAttempt"]>, Parameters<DispatchRepository["getAttempt"]>>(
      () => TE.right(O.none)
    ),
    countActiveTaskLeases: jest.fn<
      ReturnType<DispatchRepository["countActiveTaskLeases"]>,
      Parameters<DispatchRepository["countActiveTaskLeases"]>
    >(() => TE.right(0)),
    persistTransition: jest.fn<
      ReturnType<DispatchRepository["persistTransition"]>,
      Parameters<DispatchRepository["persistTransition"]>
    >(() => TE.right(undefined)),
    recordReceipt: jest.fn<
      ReturnType<DispatchRepository["recordReceipt"]>,
      Parameters<DispatchRepository["recordReceipt"]>
    >(() => TE.right(undefined))
  } satisfies DispatchRepository
  const transactions: TenantTransactionManager = {execute: (_context, computation) => computation()}
  const execute = jest.spyOn(transactions, "execute")
  const service = new DispatchService(repository, transactions, {
    dispatchConfig: {concurrencyPerOrganization: 2, leaseDurationMs: 120_000}
  })
  return {context, work, repository, service, execute}
}

describe("DispatchService claim", () => {
  it("returns the validated persisted claim and shares its evaluation time with capacity admission", async () => {
    // Given
    const {context, work, repository, service, execute} = fixture()
    const evaluateAt = new Date()
    const owner = uuidv7()
    // When
    const claim = unwrapRight(await service.claim(context, work.id, work.kind, owner, evaluateAt)())
    // Expect
    expect(claim.occ).toBe(0n)
    expect(claim.lease).toEqual({owner, fencing: 1n, expiresAt: new Date(evaluateAt.getTime() + 120_000)})
    expect(repository.countActiveTaskLeases).toHaveBeenCalledWith(context, evaluateAt)
    expect(repository.persistTransition).toHaveBeenCalledWith(
      context,
      {work},
      {
        work: expect.objectContaining({state: "claimed", fencing: claim.lease.fencing, attempts: 1, occ: 1n}),
        attempt: expect.objectContaining({id: claim.attemptId, occ: claim.occ, admittedAt: evaluateAt})
      }
    )
    expect(execute).toHaveBeenCalledWith(context, expect.any(Function), {isolationLevel: "ReadCommitted"})
  })

  it("does not persist when the organization has no free dispatch slot", async () => {
    // Given
    const {context, work, repository, service} = fixture()
    repository.countActiveTaskLeases.mockReturnValue(TE.right(2))
    // When
    const result = await service.claim(context, work.id, work.kind, uuidv7(), new Date())()
    // Expect
    expect(result).toBeLeftOf("capacity_exceeded")
    expect(repository.persistTransition).not.toHaveBeenCalled()
  })

  it("rejects an invalid claim lease before counting capacity or persisting", async () => {
    // Given
    const {context, work, repository, service} = fixture()
    // When
    const result = await service.claim(context, work.id, work.kind, uuidv7(), new Date(NaN))()
    // Expect
    expect(result).toBeLeftOf("lease_invalid_expires_at")
    expect(repository.countActiveTaskLeases).not.toHaveBeenCalled()
    expect(repository.persistTransition).not.toHaveBeenCalled()
  })
})

function ownedFixture(state: "admitted" | "executing" = "admitted") {
  const base = fixture()
  const admittedAt = new Date()
  const owner = uuidv7()
  const expiresAt = new Date(admittedAt.getTime() + 120_000)
  const work = unwrapRight(
    DispatchWorkFactory.validate({
      ...base.work,
      state: state === "admitted" ? "claimed" : "executing",
      fencing: 1n,
      lease: {owner, expiresAt}
    })
  )
  const attempt = unwrapRight(
    DispatchAttemptFactory.validate({
      id: uuidv7(),
      taskId: work.id,
      state,
      fencing: 1n,
      occ: 0n,
      admittedAt,
      ...(state === "executing" ? {executingAt: admittedAt} : {})
    })
  )
  const lease = unwrapRight(LeaseFactory.validate({owner, expiresAt, fencing: work.fencing}))
  base.repository.getWork.mockReturnValue(TE.right(work))
  base.repository.getAttempt.mockReturnValue(TE.right(O.some(attempt)))
  return {...base, work, attempt, lease}
}

describe("DispatchService recovery and completion", () => {
  it("reports a missing attempt distinctly without reading or writing work", async () => {
    // Given
    const {context, repository, service, lease} = ownedFixture()
    repository.getAttempt.mockReturnValue(TE.right(O.none))
    // When
    const result = await service.validateAttemptLease(context, uuidv7(), lease)()
    // Expect
    expect(result).toBeLeftOf("dispatch_attempt_not_found")
    expect(repository.getWork).not.toHaveBeenCalled()
    expect(repository.persistTransition).not.toHaveBeenCalled()
  })

  it.each(["admitted", "executing"] as const)(
    "recovers expired %s work using the shared evaluation time",
    async state => {
      // Given
      const {context, repository, service, work, attempt} = ownedFixture(state)
      const expired = unwrapRight(
        DispatchWorkFactory.validate({...work, lease: {owner: uuidv7(), expiresAt: new Date(0)}})
      )
      const evaluateAt = new Date()
      repository.getWork.mockReturnValue(TE.right(expired))
      // When
      const result = await service.recoverExpired(context, work.id, work.kind, evaluateAt)()
      // Expect
      expect(unwrapRight(result)).toMatchObject({
        state: state === "admitted" ? "retry_due" : "unknown",
        lease: undefined
      })
      expect(repository.getAttempt).toHaveBeenCalledWith(context, {taskId: work.id, fencing: work.fencing})
      expect(repository.persistTransition).toHaveBeenCalledWith(
        context,
        {work: expired, attempt},
        {
          work: expect.objectContaining({fencing: work.fencing + 1n, lease: undefined}),
          attempt: expect.objectContaining({completedAt: evaluateAt, outcomeCategory: "lease_expired"})
        }
      )
    }
  )

  it("rejects recovery of a live lease without loading its attempt", async () => {
    // Given
    const {context, repository, service, work} = ownedFixture()
    // When
    const result = await service.recoverExpired(context, work.id, work.kind, new Date())()
    // Expect
    expect(result).toBeLeftOf("dispatch_lease_not_expired")
    expect(repository.getAttempt).not.toHaveBeenCalled()
    expect(repository.persistTransition).not.toHaveBeenCalled()
  })

  it.each([
    ["unknown", "dispatch_recovery_already_unknown"],
    ["ready", "dispatch_recovery_not_applicable"],
    ["retry_due", "dispatch_recovery_not_applicable"],
    ["paused", "dispatch_recovery_not_applicable"],
    ["succeeded", "dispatch_recovery_not_applicable"],
    ["failed", "dispatch_recovery_not_applicable"],
    ["claimed", "dispatch_work_invalid_lease"],
    ["executing", "dispatch_work_invalid_lease"]
  ])("rejects recovery without an expired attempt for %s work", async (state, error) => {
    // Given
    const {context, repository, service, work} = fixture()
    repository.getWork.mockReturnValue(TE.right(unwrapRight(DispatchWorkFactory.validate({...work, state}))))
    // When
    const result = await service.recoverExpired(context, work.id, work.kind, new Date())()
    // Expect
    expect(result).toBeLeftOf(error)
    expect(repository.getAttempt).not.toHaveBeenCalled()
    expect(repository.persistTransition).not.toHaveBeenCalled()
  })

  it("reports an already paused task instead of claiming a pause was performed", async () => {
    // Given
    const {context, repository, service, work} = fixture()
    repository.getWork.mockReturnValue(TE.right(unwrapRight(DispatchWorkFactory.validate({...work, state: "paused"}))))
    // When
    const result = await service.parkReady(context, work.id, work.kind)()
    // Expect
    expect(result).toBeLeftOf("dispatch_work_already_paused")
    expect(repository.persistTransition).not.toHaveBeenCalled()
  })

  it("does not acknowledge a failed attempt whose task still needs execution", async () => {
    // Given
    const {context, repository, service, attempt, lease} = ownedFixture()
    const completion = unwrapRight(
      DispatchCompletionFactory.validate({
        state: "failed",
        outcome: {type: "task_load_failed", error: "task_not_found"}
      })
    )
    // When
    const result = await service.complete(context, attempt.id, lease, completion, uuidv7())()
    // Expect
    expect(result).toBeRight()
    expect(repository.persistTransition).toHaveBeenCalledWith(context, expect.anything(), {
      work: expect.objectContaining({state: "retry_due"}),
      attempt: expect.objectContaining({state: "failed"})
    })
    expect(repository.recordReceipt).not.toHaveBeenCalled()
  })

  it("records a receipt when execution completes permanently", async () => {
    // Given
    const {context, repository, service, attempt, lease} = ownedFixture("executing")
    const eventId = uuidv7()
    const completion = unwrapRight(
      DispatchCompletionFactory.validate({
        state: "failed",
        outcome: {type: "http_response", statusCode: 400}
      })
    )
    // When
    const result = await service.complete(context, attempt.id, lease, completion, eventId)()
    // Expect
    expect(result).toBeRight()
    expect(repository.recordReceipt).toHaveBeenCalledWith(context, eventId)
  })

  it("preserves a persistence failure without acknowledging the event", async () => {
    // Given
    const {context, repository, service, attempt, lease} = ownedFixture("executing")
    repository.persistTransition.mockReturnValue(TE.left("lease_lost"))
    const completion = unwrapRight(
      DispatchCompletionFactory.validate({state: "succeeded", outcome: {type: "delivered"}})
    )
    // When
    const result = await service.complete(context, attempt.id, lease, completion, uuidv7())()
    // Expect
    expect(result).toBeLeftOf("lease_lost")
    expect(repository.recordReceipt).not.toHaveBeenCalled()
  })
})
