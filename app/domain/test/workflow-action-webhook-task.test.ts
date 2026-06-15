import {WorkflowActionWebhookTaskFactory} from "../src/workflow-tasks/webhook-task"
import {TaskStatus} from "../src/workflow-tasks/base"
import {WebhookActionHttpMethod} from "../src/workflow-actions"

describe("WorkflowActionWebhookTaskFactory", () => {
  const baseTaskData = {
    id: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e6f",
    workflowId: "018d9f1b-5b5c-7d9a-8e5f-1a2b3c4d5e6f",
    url: "https://example.com/webhook",
    method: WebhookActionHttpMethod.POST,
    retryCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    occ: 0n,
    status: TaskStatus.PENDING
  }

  it("should fail validation if headers contains non-string values", () => {
    // Given
    const data = {
      ...baseTaskData,
      headers: {
        "Content-Type": "application/json",
        "X-Retry-Count": 3
      }
    }

    // When
    const result = WorkflowActionWebhookTaskFactory.validate(data)

    // Expect
    expect(result).toBeLeftOf("workflow_action_webhook_task_headers_invalid")
  })

  it("should fail validation if headers is not an object", () => {
    // Given
    const data = {
      ...baseTaskData,
      headers: "invalid"
    }

    // When
    const result = WorkflowActionWebhookTaskFactory.validate(data)

    // Expect
    expect(result).toBeLeftOf("workflow_action_webhook_task_headers_invalid")
  })

  it("should succeed validation if headers contains only string values", () => {
    // Given
    const data = {
      ...baseTaskData,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer token"
      }
    }

    const result = WorkflowActionWebhookTaskFactory.validate(data)
    expect(result).toBeRight()
  })

  it("should succeed validation if headers is undefined", () => {
    // Given
    const data = {
      ...baseTaskData,
      headers: undefined
    }

    // When
    const result = WorkflowActionWebhookTaskFactory.validate(data)

    // Expect
    expect(result).toBeRight()
  })
})
