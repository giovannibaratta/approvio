export class TaskNotFoundError extends Error {
  constructor() {
    super("Task not found")
  }
}

export class TaskLockedByOtherError extends Error {
  constructor() {
    super("Task locked by other error")
  }
}

export class TaskUnknownError extends Error {
  constructor() {
    super("Task unknown error")
  }
}
