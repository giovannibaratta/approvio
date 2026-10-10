# C2: Tenant-authenticated encryption adapter

Wave: [C](wave-C.md). Dependencies: all tasks in every earlier wave; none in this wave.

## Context and ownership

app/external/src/kms/, encryption-specific tests and adapter wiring handoff.

Read [low-level design](LOW-LEVEL-DESIGN.md) and A1's frozen contracts before implementation. Follow [execution rules](README.md). Do not change frozen interfaces independently; document any required correction at the wave barrier.

## Implementation

Implement B2 encryption port with authenticated org/resource/field/version context using existing keyring infrastructure. Verify returned authenticated context on decrypt before exposing plaintext; validate supported format/key metadata. Provide source→target re-encryption helper for immutable template/task IDs, with no cross-org transfer API. Keep external KMS operations outside transaction retry closures. Define non-secret categorized failures suitable for worker/API mapping.

## Acceptance

Tests prove A ciphertext fails in B, wrong resource/field/version fails, malformed/legacy unbound ciphertext fails, supported key versions round-trip and generated template/task copies must re-encrypt. Verify logs never contain plaintext, headers, tokens or secret URLs.

## Boundaries

Do not change repositories; D2/D3 consume this adapter. No BYOK infrastructure or DEK hierarchy redesign; F4 aligns ADR 006.

Record changed files, commands/results and deviations in your handoff. Run relevant tests and code review for the owned layer; never infer success from a mock-only test where the acceptance requires the real database or network boundary.
