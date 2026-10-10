# Task dispatch: leases, delivery, and recovery

This describes the current implementation of `TaskService.withDispatchLease`. It starts when a worker receives a `task.ready` event; task generation and outbox publication happen earlier.

Two leases cover different resources:

| Lease                 | Purpose                                                       | Owner                           |
| --------------------- | ------------------------------------------------------------- | ------------------------------- |
| Redis capacity lease  | Limit simultaneous deliveries within an organization.         | A new UUID for each execution.  |
| PostgreSQL task lease | Authorize one execution to change this task's dispatch state. | Worker ID plus a fencing token. |

Their fencing tokens are independent. OCC tracks changes to a database row; the database fencing token identifies the current execution. Claiming or invalidating it increments fencing.

## Successful delivery

The database steps below go through `DispatchService` and `DispatchRepository`. Each transaction finishes before any external call starts.

```mermaid
sequenceDiagram
    participant Q as Queue
    participant W as Worker processor
    participant T as TaskService
    participant R as Redis capacity
    participant D as PostgreSQL
    participant X as External provider

    Q->>W: task.ready(organizationId, taskId, kind)
    W->>T: withDispatchLease(..., operation)
    T->>R: Acquire capacity with a new execution UUID
    R-->>T: Capacity lease

    T->>D: Begin Serializable admission transaction
    T->>D: Recover expired attempt, if present
    T->>D: Check organization status and active dispatch count
    T->>D: Claim task, increment fencing, set lease expiry
    T->>D: Create admitted dispatch attempt
    T->>D: Commit
    D-->>T: attemptId and database lease

    T->>W: Run operation(claim, assertLease)
    W->>D: Load task payload
    W->>T: markDispatchSending(attemptId, lease)
    T->>D: Recheck organization, persist sending state

    W->>T: assertLease(), immediately before egress
    T->>R: Check capacity owner, token, and expiry
    T->>D: Check task owner, fencing, and expiry
    T-->>W: Ownership confirmed
    W->>X: Send email, webhook, or Slack message

    X-->>W: Delivery result
    W->>T: completeDispatch(attemptId, lease, outcome, eventId)
    T->>D: Atomically persist outcome, clear database lease, record receipt when applicable
    T-->>W: Completion persisted
    W-->>T: Callback returns
    T->>R: Release capacity lease
    T-->>W: withDispatchLease returns
    W-->>Q: Job handler returns
```

Both leases have a fixed duration, defaulting to two minutes. Ownership checks do not extend expiry. There is no renewal timer. HTTP timeouts and retry limits should leave time for loading the task and persisting the outcome within that window. Webhooks have a 10-second timeout per request, and Slack a 5-second timeout. Email uses SMTP with explicit DNS, connection, greeting, and socket timeouts.

## Failure and crash recovery

On an ordinary callback failure, `TE.bracket` releases Redis capacity. It does **not** automatically clear the database lease: the processor must record an outcome, or a later execution recovers it after expiry. A process crash cannot run cleanup, so both leases expire naturally.

```mermaid
sequenceDiagram
    participant A as Original execution
    participant R as Redis capacity
    participant D as PostgreSQL
    participant B as Later execution

    A->>D: Claim task with fencing token N
    Note over A,D: Original execution crashes or stalls
    Note over R,D: Leases expire
    B->>R: Acquire capacity
    B->>D: Read expired work and persisted attempt

    alt Work was claimed, sending had not been recorded
        B->>D: Set retry_due, clear lease, increment fencing
        B->>D: Claim again and create a new attempt
        Note over B,D: Retry is allowed if the organization is active
    else Work was sending
        B->>D: Set unknown, clear lease, increment fencing
        alt Active organization and webhook
            B->>D: Claim again with a new attempt
            Note over B,D: Webhook retry uses the immutable task ID as Idempotency-Key
        else Email, Slack, or inactive organization
            D-->>B: Park this execution, do not send
        end
    end

    opt Original execution resumes
        A->>D: Check ownership or complete using fencing token N
        D-->>A: lease_lost, old ownership cannot modify the task
    end
```

`sending` is recorded before the external call. A crash between that write and the call also produces `unknown`, even if nothing was sent. This is conservative: the database cannot prove whether the provider received the request.

If an ownership check fails, `assertLease()` rejects before egress. A call already in flight cannot be recalled by a lease check; fencing protects database writes, and downstream idempotency is still required to deduplicate external effects. A cleanup failure is logged and does not replace the delivery result. If processing exceeds the lease, completion is rejected and expired work must be recovered.

## Where the complexity comes from

| Requirement                                              | Mechanism used                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Organization isolation                                   | Explicit tenant context and PostgreSQL RLS.                            |
| Per-organization delivery concurrency                    | Redis capacity lease, plus a Serializable database count at admission. |
| Reject stale executions                                  | Database lease owner, expiry, fencing, and OCC predicates.             |
| Recover after crashes without blindly repeating delivery | Persisted admitted/sending attempts and unknown outcomes.              |

Tenant isolation alone does not require the two leases. Those come from concurrency limits, expiring ownership, and external-delivery recovery.

The heartbeat has been removed: a fixed two-minute lease trades longer crash recovery for a simpler execution path. Removing Redis capacity would require deciding whether the database admission count adequately covers the desired concurrency limit. Removing persisted attempts would lose the distinction between a crash before sending and an uncertain delivery. These remaining alternatives have not been implemented or validated.

## Code references

- [TaskService: capacity lifetime and processor API](../../app/services/src/task/task.service.ts)
- [DispatchService: admission, ownership checks, recovery, and completion](../../app/services/src/durable-work/dispatch.service.ts)
- [DispatchTransitionFactory: ownership checks and state transitions](../../app/services/src/durable-work/dispatch.models.ts)
- [Email processor: load, mark sending, assert lease, send, complete](../../app/worker/src/processor/workflow-action-email.processor.ts)
- [Lifecycle integration tests](../../app/services/test/durable-work/task-dispatch-lifecycle.integration.test.ts)
