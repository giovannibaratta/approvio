import {AsyncLocalStorage} from "node:async_hooks"

/**
 * Utility class to store and retrieve request-scoped data (like traceparent)
 * throughout the lifetime of an asynchronous request (API call), without passing it as a function argument.
 *
 * It uses Node.js `AsyncLocalStorage` to create a context that is preserved across async callbacks and promises.
 * This is essential for logging, where we want to include the trace ID in every log message without
 * threading the ID through every single function call.
 */
export class RequestContext {
  // The AsyncLocalStorage instance that holds our stringstore (traceparent)
  private static readonly cls = new AsyncLocalStorage<string>()

  /**
   * Retrieves the current request's ID (traceparent) from the local storage.
   * returns an empty string if called outside of an active request context.
   */
  static get currentRequestId(): string {
    return this.cls.getStore() || ""
  }

  /**
   * Runs a callback within the context of the given request ID.
   * Any async operations started within the callback will have access to this ID.
   *
   * @param requestId - The traceparent string to store.
   * @param callback - The function to execute within this context.
   */
  static run(requestId: string, callback: () => void): void {
    this.cls.run(requestId, callback)
  }
}
