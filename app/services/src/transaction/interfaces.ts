import {TaskEither} from "fp-ts/TaskEither"
import {UnknownError} from "../error"

export const TRANSACTION_MANAGER_TOKEN = "TRANSACTION_MANAGER_TOKEN"

export type TransactionIsolationLevel = "ReadUncommitted" | "ReadCommitted" | "RepeatableRead" | "Serializable"

export type TransactionOptions = {
  isolationLevel?: TransactionIsolationLevel
}

export type ExecutionError = UnknownError | "conflicting_isolation_level"

export interface TransactionManager {
  /**
   * Executes a given computation within a transactional scope.
   *
   * All database (and only the database) operations performed via repositories within the provided
   * `computation` will be part of the same transaction. If the computation returns a `left` (error),
   * the transaction will be rolled back. If it returns a `right` (success),
   * the transaction will be committed.
   *
   * @example
   * ```typescript
   * class UserService {
   *   constructor(
   *     private readonly txManager: TransactionManager,
   *     private readonly userRepository: UserRepository,
   *     private readonly auditRepository: AuditRepository,
   *   ) {}
   *
   *   public createUser(data: CreateUserDto) {
   *     return this.txManager.execute(() => pipe(
   *       this.userRepository.create(data),
   *       TE.chain(user => pipe(
   *         this.auditRepository.log({ action: 'USER_CREATED', entityId: user.id }),
   *         TE.map(() => user)
   *       ))
   *     ));
   *   }
   * }
   * ```
   *
   * @param computation - A function returning a `TaskEither` to be executed transactionally.
   * @param options - Optional configuration for the transaction (e.g. isolation level).
   * @returns The result of the computation.
   */
  execute<T, E extends string>(
    computation: () => TaskEither<E, T>,
    options?: TransactionOptions
  ): TaskEither<E | ExecutionError, T>
}
