# Withdrawn vote authorization proposal

Status: withdrawn by user decision on 2026-10-05. No voting production change was implemented.

The proposed stricter mid-request role-revocation boundary is outside the current scope. Voting keeps
its existing optimistic authorization behavior: a request may continue with the principal resolved
earlier, and recalculation evaluates recorded votes without rechecking each voter's current eligibility.
This is an accepted limitation, not a missing implementation for this pass.

The regression that asserted zero votes after role revocation was based on the rejected requirement
and has been removed. Previous ledger entries describing it as a mandatory E4 fix are superseded by
this decision. Existing vote persistence, expiry checks, step-up behavior and publication logic remain
unchanged. Organization resume/reconciliation is also deferred by the user.
