# ADR-005: Generic Framework for Encrypting Sensitive Data at Rest

**Status:** Proposed
**Date:** 2024-05-24
**Context:** Need for a generic, reusable framework to encrypt sensitive data at rest (e.g., webhook actions, third-party API keys, authentication tokens) across the application.

## Problem

The application processes and stores sensitive data, such as API keys, authentication tokens, and webhook action configurations that contain secrets. Storing this information in plain text in the database exposes it to severe risks in the event of a database compromise, unauthorized access, or backup theft. We need a reusable, generic framework to ensure all sensitive fields across various domain entities are securely encrypted at rest. The solution must support common compliance standards (e.g., ISO 27001, SOC 2, GDPR) and manage encryption keys securely.

## Options Considered

### Option 1: Application-Level Encryption (Prisma Extension / Node Crypto)

Encryption and decryption happen within the Node.js application layer before data is sent to or retrieved from the database. This can be implemented using Node's native `crypto` module (e.g., AES-256-GCM) or via Prisma Client Extensions (like the community package `prisma-extension-encryption` or a custom adhoc middleware built using Prisma's `client.$extends` API).

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
  - **Strong Security Posture:** Data is encrypted in transit between the app and the DB, and remains encrypted in DB memory and backups.
  - **Compliance:** Meets ISO 27001 / SOC 2 requirements for data-at-rest encryption.
- ❌ **Cons:**
  - **Query Limitations:** Encrypted fields cannot be easily searched, filtered, or sorted in database queries (unless implementing complex deterministic encryption or blind indexing).
  - **Performance:** Small overhead for encryption/decryption operations on the Node.js server.
  - **Implementation Effort:** Medium to High. Requires setting up the Prisma extension, migrating existing plaintext data, and securely managing the Data Encryption Key (DEK).
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

### Option 3: External Secret Manager (HashiCorp Vault / AWS Secrets Manager)

Instead of storing sensitive data in the application database, we store it in a dedicated Secret Manager. The database only stores a reference (e.g., a Vault path or secret ID).

- ✅ **Pros:**
  - **Highest Security:** Secrets are isolated in a specialized, hardened environment with strict access controls and detailed audit logging.
  - **Built-in Key Rotation:** Secret managers natively handle key lifecycle management.
- ❌ **Cons:**
  - **Architecture Complexity:** Introduces a hard dependency on an external system for core application flows.
  - **Performance/Latency:** Requires an extra network hop to fetch secrets for every operation that needs them.
  - **Implementation Effort:** High. Requires significant refactoring of how entities access data and robust error handling for secret manager unavailability.

## Key Management Strategy (KMS)

Regardless of the chosen encryption method (specifically for Option 1), managing the master keys securely is critical. The options are:

1. **Environment Variables:**
   - *Pros:* Simple to implement.
   - *Cons:* Weakest security. Keys can easily leak in logs, CI/CD pipelines, or process inspection. Does not support easy key rotation.
2. **Cloud KMS (AWS KMS, Google Cloud KMS, Azure Key Vault):**
   - *Pros:* Industry standard. Keys never leave the KMS HSM (Hardware Security Module). Supports automatic rotation and fine-grained access policies. Envelope encryption (encrypting a local Data Encryption Key with the KMS Master Key) minimizes KMS API calls.
   - *Cons:* Cloud vendor lock-in, slight latency on key fetching (mitigated by caching/envelope encryption).
   - *On-Premise / Local Development:* For local development, this can be mocked using a static key or a "no-op" KMS provider implementation. For on-premise environments, solutions like HashiCorp Vault (running locally/on-prem), a local HSM (Hardware Security Module), or securely distributed file-based keys managed by operations can be used as the KMS provider.

#### DEK Management Strategies
When using envelope encryption, managing the Data Encryption Key (DEK) is crucial. Two main strategies exist:

1. **Shared DEK (Recommended for simplicity/performance):** A single DEK is used to encrypt multiple rows/entities (e.g., scoped per tenant, or globally). The KMS decrypts the DEK on application startup (or periodically), and the plaintext DEK is cached in memory. This eliminates the need to query the KMS for every database row, dramatically improving performance, while the Master Key remains secure in the KMS.
2. **Per-Row DEK (Highest Security):** A unique DEK is generated for every row. The encrypted DEK is stored alongside the encrypted data in the database. When retrieving the row, the application must query the KMS to decrypt the specific DEK. This maximizes security but incurs high latency and significant KMS API costs, making it unsuited for high-volume endpoints without complex caching.

## Comparison Matrix

| Option | Implementation Effort | Queryability | Security Level | Cloud Agnostic | Meets Strict Compliance |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Option 1 (App-Level)** | Medium/High | Poor | High | Yes | Yes |
| **Option 2 (DB/Disk-Level)** | Low | Full | Low (Disk only) | No | Partial |
| **Option 3 (External Vault)** | High | None | Highest | Partial | Yes |

## Recommendations

Given the requirement for a **reusable, generic framework** specifically targeting highly sensitive fields like API keys and webhook secrets, **Option 1 (Application-Level Encryption)** combined with a **Cloud KMS for envelope encryption** is the most robust approach.

### Rationale

1. **Targeted Security:** Application-level encryption ensures that even if the database is compromised, the sensitive fields remain protected. This is crucial for webhook payloads and external API credentials.
2. **Generic Framework:** A Prisma Extension can be configured centrally to intercept and encrypt specific fields across any entity, providing a reusable pattern for future features.
3. **Queryability Trade-off:** API keys and webhook action payloads are rarely searched or sorted by their exact value, making the loss of database-level queryability on these fields an acceptable trade-off.
4. **Compliance:** Meets stringent ISO 27001 and SOC 2 requirements by ensuring secrets are not exposed to database administrators or internal tools with raw DB access.

*Implementation Note:* To address key management, Envelope Encryption should be used. The application generates a Data Encryption Key (DEK) used to encrypt the fields. This DEK is then encrypted by a Master Key managed in a Cloud KMS (or HashiCorp Vault). The application stores the encrypted DEK and decrypts it at runtime via the KMS.