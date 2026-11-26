# Durable task OCC and lease fencing

Durable work uses two monotonic values with different responsibilities.

## OCC

`occ` is the durable row version.

Every mutation of the durable-work row, including claim and reclaim, advances
`occ`. A caller supplies the version it read; an update succeeds only when
that version is still current.

OCC answers:

> Did this row change since I read it?

## Fencing

`fencing` is the lease-generation token. Each new claim or reclaim advances it
and gives the worker a lease epoch.

Lease-protected writes must match the current fencing value, owner, and
unexpired lease. A worker from an older epoch cannot complete or overwrite work
after its lease is lost.

Fencing answers:

> Does this operation belong to the current lease holder?

They are both monotonic, but they are not interchangeable. A claim advances
both values. A reclaim creates a new fencing epoch even when no business
payload changed.

## Lease expiry and external work

Fencing cannot stop a worker that is already executing an external request.
Lease expiry cannot recall an in-flight network call.

The task state machine must not blindly reclaim `sending` work. Ambiguous
external outcomes become `unknown` and require downstream idempotency or
explicit reconciliation before another attempt. Fencing protects the database
transition; it does not provide exactly-once external delivery.
