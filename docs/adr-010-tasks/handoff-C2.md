# C2 handoff

Result: C2 is complete on `adr-010-backend-integration`. New tenant and platform encryption adapters implement the B2 ports using the existing AWS Encryption SDK keyring and authenticated encryption context.

## Encryption format and binding

- New ciphertext uses the explicit `approvio:enc:v1:` prefix. Missing, malformed and legacy unbound ciphertext is rejected as `unsupported_format`; it is never treated as a valid context-bound payload.
- Tenant encryption authenticates organization ID, resource type, immutable resource ID, field and format version. Runtime validation rejects invalid UUIDs, unsupported versions and invalid field/resource combinations before encryption or decryption.
- Decryption verifies the complete expected authenticated context before exposing plaintext. The authenticated key-version metadata must be a supported positive version; the keyring itself must contain the referenced decrypt key.
- Platform PKCE encryption authenticates the provider-connection ID and a SHA-256 digest of opaque state, avoiding state disclosure in the unencrypted message header.
- Re-encryption first rejects cross-organization targets, then decrypts under the exact source binding and encrypts under the target immutable resource binding. Copies cannot reuse the source ciphertext.

## Failure and logging behavior

- Failures use the frozen non-secret categories: `encryption_failed`, `decryption_failed`, `binding_mismatch` and `unsupported_format`.
- The context-bound adapter does not log encryption exceptions, ciphertext headers, plaintext or input context. Tests exercise failure paths with a credential-bearing URL and prove it, its token and the ciphertext are absent from logger calls.
- External cryptographic work remains a `TaskEither` operation owned by callers outside retryable database closures; C2 does not add repository calls or transaction integration.

## Compatibility and wiring

- The existing unbound `EncryptionService` remains temporarily available only because untouched D2/D3 repositories still consume it. Its ciphertext is deliberately rejected by the new adapters. Those repositories must migrate and re-encrypt generated copies before the later integration gate.
- `KmsModule` now provides and exports `TenantEncryptionService` and `PlatformEncryptionService` alongside the legacy service. No key hierarchy, BYOK or repository behavior changed.

## Verification

- `yarn test:jest app/external/test/kms --silent`: 3 suites and 17 tests passed.
- Isolated C2 TypeScript (`/tmp/approvio-c2.json`): passed.
- Scoped ESLint over the C2 implementation, module/barrel and tests: passed.
- `git diff --check`: passed.

No commit, stash, push or package publication was performed.
