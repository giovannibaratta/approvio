export type UnknownError = "unknown_error"
export type PaginationError = "invalid_page" | "invalid_limit"
export type ConcurrentModificationError = "concurrent_modification_error"
export type AuthorizationError = "requestor_not_authorized"
export type EncryptionError = "encryption_failed" | "decryption_failed"

/**
 * Opaque infrastructure failure returned by a repository.
 *
 * Repositories log safe diagnostics locally and return this literal without a driver error,
 * query, credentials or tenant data. Services may decide whether a retry is safe; controllers
 * should map it to a generic 500 response.
 */
export type RepositoryDependencyError = "repository_dependency_error"
