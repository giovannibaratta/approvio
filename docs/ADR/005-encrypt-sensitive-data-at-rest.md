# ADR-005: Generic Framework for Encrypting Sensitive Data at Rest

**Status:** Accepted
**Date:** 2026-06-03
**Context:** Need for a generic, reusable framework to encrypt sensitive data at rest (e.g., webhook actions, third-party API keys, authentication tokens) across the application. The solution must be cloud-agnostic, support self-hosted and on-premise deployments, and provide a clear path toward compliance standards (e.g., ISO 27001, SOC 2, GDPR).

## Problem

The application processes and stores sensitive data, such as API keys, authentication tokens, and webhook action configurations that contain secrets. Storing this information in plain text in the database exposes it to severe risks in the event of a database compromise, unauthorized access, or backup theft. We need a reusable, generic framework to ensure all sensitive fields across various domain entities are securely encrypted at rest.

## Options Considered

### Option 1: Application-Level Encryption (Prisma Extension / AWS Encryption SDK)

Encryption and decryption happen within the Node.js application layer before data is sent to or retrieved from the database. This is implemented using the AWS Encryption SDK (`@aws-crypto/client-node`) with a `RawAesKeyring` for local key management, integrated transparently via Prisma Client Extensions (`client.$extends` API).

Despite its name, the AWS Encryption SDK operates **fully locally** when using `RawAesKeyring` — no AWS account or cloud dependency is required. It handles IV generation, ciphertext formatting, key commitment, and envelope encryption automatically.

**Example Configuration & Impact:**
A custom Prisma extension intercepting `create`, `update`, and `find` operations:

```typescript
const prisma = new PrismaClient().$extends({
  query: {
    webhookAction: {
      async create({ args, query }) {
        if (args.data.secretPayload) {
          args.data.secretPayload = encrypt(args.data.secretPayload);
        }
        return query(args);
      },
      // similar interceptors for update, findUnique, findMany...
    }
  }
});
```
With this setup, the current Prisma calls in the application remain unaffected. Developers continue calling `prisma.webhookAction.create({ data: { secretPayload: 'my-secret' } })`, and the extension transparently handles encryption before insertion and decryption upon retrieval. Configuration is applied globally at the Prisma client initialization.

- ✅ **Pros:**
  - **Granular Control:** We define exactly which fields are encrypted on a per-entity basis.
  - **Database Agnostic:** Works regardless of the underlying database engine.
  - **Cloud Agnostic:** The `RawAesKeyring` uses local keys with no cloud dependency. Cloud KMS providers can be added later behind an abstraction.
  - **Strong Security Posture:** Data is encrypted in transit between the app and the DB, and remains encrypted in DB memory and backups.
  - **Misuse Resistant:** The AWS Encryption SDK handles IV/nonce generation, ciphertext formatting, key commitment, and authenticated encryption automatically, eliminating common cryptographic implementation mistakes.
  - **Compliance:** Meets ISO 27001 / SOC 2 requirements for data-at-rest encryption.
- ❌ **Cons:**
  - **Query Limitations:** Encrypted fields cannot be easily searched, filtered, or sorted in database queries (unless implementing complex deterministic encryption or blind indexing).
  - **Performance:** Small overhead for encryption/decryption operations on the Node.js server.
  - **Implementation Effort:** Medium. Requires setting up the Prisma extension and securely managing the Data Encryption Key (DEK).
  - **Transaction Complexity:** Introduces complexity in managing transactions and atomic operations, especially if decryption fails or if business logic relies heavily on database-level constraints on encrypted fields.

### Option 2: Database-Level Encryption (Transparent Data Encryption - TDE / Cloud Provider Disk Encryption)

Encryption is handled entirely by the database engine or the cloud infrastructure (e.g., AWS EBS encryption, RDS encryption, Azure Disk Encryption).

- ✅ **Pros:**
  - **Zero Application Changes:** The Node.js application is completely unaware of the encryption. No code changes required.
  - **Full Query Capability:** Data is decrypted in DB memory, meaning all SQL operations (filtering, sorting, full-text search) work normally.
  - **Implementation Effort:** Low. Usually a toggle in the cloud provider console.
- ❌ **Cons:**
  - **Weaker Threat Model:** Protects only against physical theft of disks or backups. If an attacker gains DB access (e.g., via SQL injection or compromised DB credentials), data is returned in plain text.
  - **Compliance Gaps:** While it checks the basic "encryption at rest" box for some audits, it often falls short for strict interpretations of isolating application secrets from database administrators.
  - **Not available in all environments:** Self-hosted or on-premise deployments may not support TDE without additional infrastructure.

### Option 3: External Secret Manager (HashiCorp Vault / AWS Secrets Manager)

Instead of storing sensitive data in the application database, we store it in a dedicated Secret Manager. The database only stores a reference (e.g., a Vault path or secret ID).

- ✅ **Pros:**
  - **Highest Security:** Secrets are isolated in a specialized, hardened environment with strict access controls and detailed audit logging.
  - **Built-in Key Rotation:** Secret managers natively handle key lifecycle management.
- ❌ **Cons:**
  - **Architecture Complexity:** Introduces a hard dependency on an external system for core application flows.
  - **Performance/Latency:** Requires an extra network hop to fetch secrets for every operation that needs them.
  - **Implementation Effort:** High. Requires significant refactoring of how entities access data and robust error handling for secret manager unavailability.
  - **Additional Infrastructure:** Requires deploying and maintaining a separate service (e.g., HashiCorp Vault), adding operational burden.

## Comparison Matrix

| Option | Implementation Effort | Queryability | Security Level | Cloud Agnostic | Meets Strict Compliance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Option 1 (App-Level)** | Medium | Poor | High | Yes | Yes |
| **Option 2 (DB/Disk-Level)** | Low | Full | Low (Disk only) | No | Partial |
| **Option 3 (External Vault)** | High | None | Highest | Partial | Yes |

## Decision

Given the requirement for a **reusable, cloud-agnostic framework** specifically targeting highly sensitive fields like API keys and webhook secrets, **Option 1 (Application-Level Encryption)** combined with an **abstracted KMS provider for envelope encryption** is the most robust approach.

### Rationale

1. **Targeted Security:** Application-level encryption ensures that even if the database is compromised, the sensitive fields remain protected. This is crucial for webhook payloads and external API credentials.
2. **Generic Framework:** A Prisma Extension can be configured centrally to intercept and encrypt specific fields across any entity, providing a reusable pattern for future features.
3. **Queryability Trade-off:** API keys and webhook action payloads are rarely searched or sorted by their exact value, making the loss of database-level queryability on these fields an acceptable trade-off.
4. **Compliance:** Meets stringent ISO 27001 and SOC 2 requirements by ensuring secrets are not exposed to database administrators or internal tools with raw DB access.
5. **Cloud Independence:** Using the AWS Encryption SDK with `RawAesKeyring` provides battle-tested envelope encryption without requiring any cloud infrastructure.

### Defense-in-Depth: DB-Level Encryption (Supplementary)

Options 1 and 2 are **not mutually exclusive**. If/when the service is deployed on infrastructure that supports TDE (e.g., managed PostgreSQL with disk encryption), enabling it as a baseline layer is recommended. This covers edge cases that app-level encryption does not address (temporary tables, WAL logs, query plan caches) at near-zero additional cost. This is a **deployment-time decision**, not an application architecture decision.

## Encryption Library

The encryption framework will use the **AWS Encryption SDK** (`@aws-crypto/client-node`) with a `RawAesKeyring`. Despite the "AWS" in the name, this SDK operates **fully locally** when using `RawAesKeyring` — no AWS account, no cloud dependency.

**Why this library:**

- **Automatic IV/Nonce management:** Generates unique IVs per encryption operation, eliminating the critical risk of nonce reuse (which completely breaks AES-GCM confidentiality and authenticity).
- **Built-in ciphertext format:** Includes version metadata, algorithm suite identifier, encrypted data keys, and the encrypted data in a standard format. No need to manually define and maintain a ciphertext wire format.
- **Key commitment:** Prevents attacks where a ciphertext could be decrypted with multiple keys.
- **Envelope encryption built-in:** Natively supports the DEK/KEK pattern.
- **Multi-key support:** Multiple keyrings can be configured, enabling key rotation by decrypting with old keys and encrypting with new ones.

**Alternatives considered and rejected:**

| Library | Reason for Rejection |
| :--- | :--- |
| Google Tink (JS) | JavaScript implementation was deprecated and removed in 2023. Not viable. |
| Raw `node:crypto` | Zero dependencies but requires manual IV generation, ciphertext format design, auth tag handling, and versioning. High risk of subtle implementation bugs. |
| `sodium-native` (libsodium) | Excellent misuse-resistant library, but uses XChaCha20-Poly1305 instead of AES — may require extra justification in compliance contexts that specifically name AES. |

## Encryption Granularity

### Whole-Blob Encryption for JSON Fields

Encrypted JSON fields (e.g., `headers`, `actions`) will be encrypted as a **single blob**, not selectively by key or entry.

**Rationale:**
- Selectively encrypting individual header values would require maintaining a list of "sensitive" header names (e.g., `Authorization`, `X-API-Key`) and constantly updating it. This is error-prone and adds complexity for marginal debugging benefit.
- Selectively encrypting only webhook action entries within a mixed JSON array (containing both email and webhook actions) requires parsing, identifying, encrypting, and reassembling — significant complexity for near-zero benefit.
- The marginal overhead of encrypting non-sensitive data alongside sensitive data is negligible for the volumes involved.
- Decrypted values are available at execution time in application logs (with appropriate redaction) for debugging purposes.

**Future optimization:** If profiling reveals encryption as a performance bottleneck, selective encryption within JSON structures can be considered. This is not expected given the current data patterns.

### API-Level Redaction of Sensitive Fields

As a complementary measure to encryption at rest, the response APIs should **redact** sensitive field values on a best-effort basis. Encrypted fields such as webhook headers and URL portions containing tokens should not be returned in plaintext through API responses.

This follows a **write-once, use-internally** pattern: secrets are accepted at creation time, stored encrypted, and used internally for execution (e.g., outbound webhook calls), but are never exposed back to the caller via read APIs. This is analogous to how API key generation flows work — the key is shown once at creation and cannot be retrieved afterward.

**Scope:**
- Webhook action `headers` in workflow template responses: redact header values (e.g., replace with `"***"`).
- Webhook task `headers` and `url` query parameters: redact sensitive portions in task status responses.
- This is a best-effort defense-in-depth measure. The primary protection remains encryption at rest.

## Sensitive Fields Inventory

The following fields are identified as requiring encryption:

| Table | Field(s) | Type | Sensitivity | Priority |
| :--- | :--- | :--- | :--- | :--- |
| `workflow_actions_webhook_tasks` | `headers` | JSON | **High** — may contain `Authorization: Bearer <token>`, API keys | P0 |
| `workflow_templates` | `actions` | JSON | **High** — contains webhook URLs and headers for configured actions | P0 |
| `workflow_actions_webhook_tasks` | `url` | String | **Medium** — URLs may contain tokens in query parameters | P1 |
| `pkce_sessions` | `code_verifier` | String | **Medium** — short-lived PKCE code verifiers | P2 |

## Key Management Strategy

### KMS Provider Abstraction

To support cloud-agnostic and self-hosted deployments, the encryption framework will use a **KMS Provider abstraction layer**. The core encryption logic (Prisma extension, ciphertext format, envelope encryption) is identical regardless of the KMS provider. Only the DEK wrapping/unwrapping differs.

```typescript
interface KmsProvider {
  /** Encrypt the DEK using the master key */
  encryptDek(plaintextDek: Buffer): Promise<Buffer>
  /** Decrypt the DEK using the master key */
  decryptDek(encryptedDek: Buffer): Promise<Buffer>
  /** Identifier for the current master key version */
  getCurrentKeyVersion(): string
}
```

### Provider Implementations

| Provider | Use Case | How It Works | Status |
| :--- | :--- | :--- | :--- |
| **`EnvVarKmsProvider`** | Local dev, simple self-hosted | Reads a 256-bit master key from an environment variable. DEK encrypted with AES-256-GCM using this key. | **Initial implementation** |
| **`FileKmsProvider`** | Self-hosted production | Reads master key from a file with restricted permissions (`chmod 400`). Supports key rotation by reading versioned key files. | Planned |
| **`VaultKmsProvider`** | Self-hosted high-security | Delegates to HashiCorp Vault's Transit Secrets Engine. | Future (example provider) |
| **Cloud KMS Providers** | AWS / GCP / Azure | One provider per cloud platform, delegating to the respective KMS API. | Future (per-provider) |

### Provider Selection

Provider selection is configuration-driven:

```typescript
const kmsProvider = KmsProviderFactory.create({
  type: process.env.KMS_PROVIDER_TYPE ?? "env_var",
  config: { /* Provider-specific config from env vars */ }
})
```

### Local Development

For local development, use `EnvVarKmsProvider` with a static key set in `.env`:

```bash
# .env.development (NOT committed to git)
KMS_PROVIDER_TYPE=env_var
KMS_MASTER_KEY=<base64-encoded-32-byte-key>
```

A development key can be generated with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The `.env` file containing the master key must be listed in `.gitignore`. A `.env.example` with a placeholder should guide developers.

### DEK Management Strategy

When using envelope encryption, managing the Data Encryption Key (DEK) is crucial. Two main strategies exist:

1. **Shared DEK (Recommended for simplicity/performance):** A single DEK is used to encrypt multiple rows/entities (e.g., scoped per tenant, or globally). The KMS provider decrypts the DEK on application startup (or periodically), and the plaintext DEK is cached in memory. This eliminates the need to query the KMS for every database row, dramatically improving performance, while the Master Key remains secure in the KMS.
2. **Per-Row DEK (Highest Security):** A unique DEK is generated for every row. The encrypted DEK is stored alongside the encrypted data in the database. When retrieving the row, the application must query the KMS to decrypt the specific DEK. This maximizes security but incurs high latency and significant KMS API costs, making it unsuited for high-volume endpoints without complex caching.

### Key Rotation

Key rotation should be supported from day one as a low-cost compliance preparedness measure:

1. **Ciphertext versioning:** The AWS Encryption SDK natively includes key metadata in its ciphertext format. Different ciphertext records can be encrypted with different DEK versions.
2. **Lazy re-encryption:** On read/update, data encrypted with an old DEK is decrypted and re-encrypted with the current DEK. This avoids the need for a dedicated batch re-encryption job.
3. **Configurable cadence:** Default rotation period of 365 days, configurable down to 90 days for stricter compliance requirements (e.g., SOC 2 Type II).

## Security Considerations

### Redis / BullMQ Queue Exposure

Sensitive data also flows through Redis-backed BullMQ queues (e.g., `WorkflowActionWebhookEvent`). The encryption framework addresses database storage but does not directly cover queue payloads.

**Mitigations:**
- Queue events must contain **only task IDs** (references), not actual secret data. The worker retrieves and decrypts secrets from the database at execution time.
- If secrets must transit through queues in future use cases, they must be encrypted before enqueuing.
- Redis TLS and authentication should be enabled regardless.

### Error Handling

Decryption failures must not leak cryptographic material:

- Error messages must be generic (e.g., `"data_integrity_error"`), not including ciphertext, IVs, DEKs, or key identifiers.
- Crypto failures should be logged via the application logger (NestJS `Logger`) with a `CRYPTO` context/namespace for operational visibility. These are **system/maintainer logs**, distinct from the user-facing audit log system.

### In-Memory Exposure

Decrypted field values and the cached plaintext DEK reside in Node.js process memory. This is an inherent limitation of application-level encryption. Core dumps or heap snapshots could expose decrypted secrets.

**Accepted risk.** Mitigations: use `Buffer` for sensitive operations where feasible, disable core dumps in production, and restrict process introspection access.

### Threat Model

| Threat | Addressed? | Notes |
| :--- | :--- | :--- |
| DB compromise via SQL injection | ✅ Yes | Encrypted fields remain protected |
| Unauthorized DB admin access | ✅ Yes | Admin sees only ciphertext |
| Backup theft | ✅ Yes | Backups contain only ciphertext |
| Insider threat (DB level) | ✅ Yes | DEK not stored in DB |
| Application server compromise | ⚠️ Accepted | Inherent to app-level encryption architecture. Mitigated by securing the compute runtime (container hardening, network policies, principle of least privilege, runtime security monitoring). |
| Redis/queue data exposure | ⚠️ Mitigated | Queue events must use references, not secrets |
| Log file exposure | ⚠️ Mitigated | Error handling must sanitize crypto material |
| Memory dump attacks | ⚠️ Accepted | Inherent to app-level encryption. Mitigated by disabling core dumps in production, restricting process introspection, and securing the compute runtime. |
| Key compromise via poor storage | ⚠️ Mitigated | KMS provider abstraction enables secure key storage upgrades |

## Pending Action Items

The following items must be implemented as part of this architecture change:

### Encryption Framework

1. **Add `@aws-crypto/client-node` dependency** — Install the AWS Encryption SDK and configure `RawAesKeyring` with local key management.
2. **Implement `KmsProvider` interface** — Define the abstraction layer with `encryptDek`, `decryptDek`, and `getCurrentKeyVersion` methods.
3. **Implement `EnvVarKmsProvider`** — Initial provider reading the master key from environment variables.
4. **Implement Prisma Client Extension** — Transparent encrypt-on-write / decrypt-on-read for the target fields listed in the Sensitive Fields Inventory.
5. **Encrypt `workflow_actions_webhook_tasks.headers`** (P0) — Whole-blob encryption of the JSON headers column.
6. **Encrypt `workflow_templates.actions`** (P0) — Whole-blob encryption of the JSON actions column.
7. **Encrypt `workflow_actions_webhook_tasks.url`** (P1) — Encrypt the URL field.
8. **Encrypt `pkce_sessions.code_verifier`** (P2) — Encrypt the PKCE code verifier.

### API Redaction

9. **Redact webhook headers in API responses** — Replace sensitive header values with `"***"` in workflow template and task read endpoints.
10. **Redact URL query parameters in API responses** — Strip or mask token-bearing query parameters in webhook task status responses.

### Error Handling & Logging

11. **Sanitize crypto error messages** — Ensure decryption failures produce generic errors (`"data_integrity_error"`) without leaking ciphertext or key metadata.
12. **Add `CRYPTO` log context** — Introduce a dedicated logger context for crypto-related operational events.

### Queue Safety

13. **Audit BullMQ queue payloads** — Verify that `WorkflowActionWebhookEvent` and related queue events contain only task ID references, not secret data.

### Configuration & Documentation

14. **Add `KMS_PROVIDER_TYPE` and `KMS_MASTER_KEY` to `.env.example`** — Document required environment variables with placeholder values.
15. **Update `.gitignore`** — Ensure `.env` files containing master keys are excluded.
16. **Document key generation procedure** — Add instructions for generating development and production master keys.

## Future Extensions

- **`FileKmsProvider`:** File-based master key for self-hosted production deployments with restricted filesystem permissions and versioned key files.
- **`VaultKmsProvider`:** Integration with HashiCorp Vault's Transit Secrets Engine for self-hosted high-security environments.
- **Cloud KMS Providers:** Per-provider implementations (AWS KMS, Google Cloud KMS, Azure Key Vault) for managed cloud deployments.
- **Selective JSON Encryption:** If performance profiling warrants it, selectively encrypt only sensitive entries within JSON columns (e.g., only webhook actions within the `actions` array).
- **DB-Level TDE:** Enable Transparent Data Encryption at the infrastructure level as a defense-in-depth measure when deploying on supporting platforms.