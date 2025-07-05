import {
  WorkflowActionEmailTaskFactory,
  TaskStatus,
  DecoratedWorkflowActionEmailTask
} from "../src/workflow-actions-email-task"

describe("WorkflowActionEmailTaskFactory", () => {
  const baseTaskData = {
    workflowId: "workflow-123",
    configuration: {email: "test@example.com"}
  }

  describe("validate", () => {
    describe("good cases", () => {
      it("should return a valid entity when validating a plain data structure", () => {
        // Given: a plain data structure for the workflow action email task
        const taskData = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.PENDING,
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(taskData)

        // Expect:
        expect(result).toBeRightOf(expect.objectContaining(taskData))
      })

      it("should return a valid entity when validating a decorated entity", () => {
        // Given: a decorated entity for the workflow action email task
        const decoratedTask: DecoratedWorkflowActionEmailTask<{occ: true}> = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.COMPLETED,
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(decoratedTask)

        // Expect:
        expect(result).toBeRight()
      })

      it("should return a valid entity when validating a decorated entity with an error reason", () => {
        // Given: a decorated entity for the workflow action email task with an error reason
        const decoratedTask: DecoratedWorkflowActionEmailTask<{occ: true}> = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.ERROR,
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          errorReason: "Some error",
          occ: 1n
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(decoratedTask)

        // Expect:
        expect(result).toBeRight()
      })
    })

    describe("bad cases", () => {
      it("should return a validation error when the status is invalid for a plain data structure", () => {
        // Given: a plain data structure with an invalid status
        const taskData = {
          ...baseTaskData,
          id: "task-123",
          status: "INVALID_STATUS",
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(taskData)

        // Expect:
        expect(result).toBeLeftOf("workflow_action_email_task_status_invalid")
      })

      it("should return a validation error when the error reason is too long for a plain data structure", () => {
        // Given: a plain data structure with an error reason that is too long
        const taskData = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.ERROR,
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          errorReason: "a".repeat(16385)
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(taskData)

        // Expect:
        expect(result).toBeLeftOf("workflow_action_email_task_error_reason_too_long")
      })

      it("should return a validation error when the lock date is invalid", () => {
        const now = new Date(Date.now())

        // Given: a decorated entity with a lock date that is before the creation date
        const decoratedTask: DecoratedWorkflowActionEmailTask<{lock: true}> = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.PENDING,
          retryCount: 0,
          createdAt: now,
          updatedAt: now,
          lock: {
            lockedBy: "user-123",
            lockedAt: new Date(now.getTime() - 1000)
          }
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(decoratedTask)

        // Expect:
        expect(result).toBeLeftOf("workflow_action_email_task_lock_date_prior_creation")
      })

      it("should return a validation error when the lockedBy is too long", () => {
        // Given: a decorated entity with a lockedBy that is too long
        const decoratedTask: DecoratedWorkflowActionEmailTask<{occ: true; lock: true}> = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.PENDING,
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n,
          lock: {
            lockedBy: "a".repeat(1025),
            lockedAt: new Date()
          }
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(decoratedTask)

        // Expect:
        expect(result).toBeLeftOf("workflow_action_email_task_lock_by_too_long")
      })

      it("should return a validation error when the lockedBy is empty", () => {
        // Given: a decorated entity with an empty lockedBy
        const decoratedTask: DecoratedWorkflowActionEmailTask<{occ: true; lock: true}> = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.PENDING,
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n,
          lock: {
            lockedBy: "",
            lockedAt: new Date()
          }
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(decoratedTask)

        // Expect:
        expect(result).toBeLeftOf("workflow_action_email_task_lock_by_is_empty")
      })

      it("should return a validation error when the lockedBy has an invalid format", () => {
        // Given: a decorated entity with a lockedBy that has an invalid format
        const decoratedTask: DecoratedWorkflowActionEmailTask<{occ: true; lock: true}> = {
          ...baseTaskData,
          id: "task-123",
          status: TaskStatus.PENDING,
          retryCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          occ: 1n,
          lock: {
            lockedBy: "-invalid-format",
            lockedAt: new Date()
          }
        }

        // When:
        const result = WorkflowActionEmailTaskFactory.validate(decoratedTask)

        // Expect:
        expect(result).toBeLeftOf("workflow_action_email_task_lock_by_invalid_format")
      })
    })
  })
})
