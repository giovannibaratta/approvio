import {
  TaskStateMachine,
  TaskStatus,
  WorkflowActionEmailTaskFactory,
  WorkflowActionSlackTaskFactory,
  WorkflowActionWebhookTaskFactory,
  WebhookActionHttpMethod
} from "@domain"
import {randomOrgId} from "@test/organization-id"
import {v7 as uuidv7} from "uuid"

describe("durable task domain", () => {
  it("rejects unsafe task state jumps", () => {
    expect(TaskStateMachine.transition("ready", "claimed")).toBeRightOf("claimed")
    expect(TaskStateMachine.transition("claimed", "executing")).toBeRightOf("executing")
    expect(TaskStateMachine.transition("executing", "succeeded")).toBeRightOf("succeeded")
    expect(TaskStateMachine.transition("ready", "succeeded")).toBeLeftOf("task_invalid_transition")
    expect(TaskStateMachine.transition("succeeded", "claimed")).toBeLeftOf("task_invalid_transition")
  })
})

describe.each([
  {
    kind: "email",
    validate: (input: unknown) => WorkflowActionEmailTaskFactory.validate(input),
    payload: {recipients: ["test@example.com"], subject: "Update", body: "Approved"}
  },
  {
    kind: "webhook",
    validate: (input: unknown) => WorkflowActionWebhookTaskFactory.validate(input),
    payload: {url: "https://example.com/webhook", method: WebhookActionHttpMethod.POST}
  },
  {
    kind: "slack",
    validate: (input: unknown) => WorkflowActionSlackTaskFactory.validate(input),
    payload: {webhookUrl: "https://hooks.slack.com/services/test"}
  }
])("$kind task lifecycle validation", ({validate, payload}) => {
  const task = {
    id: uuidv7(),
    organizationId: randomOrgId(),
    workflowId: uuidv7(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...payload
  }

  it.each(Object.values(TaskStatus))("retains the %s state and stored attempt count", status => {
    // When
    const result = validate({...task, status, retryCount: 2})
    // Expect
    expect(result).toBeRightOf(expect.objectContaining({status, retryCount: 2}))
  })

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid attempt count: %s", retryCount => {
    // When
    const result = validate({...task, status: TaskStatus.READY, retryCount})
    // Expect
    expect(result).toBeLeftOf("workflow_action_task_missing_or_invalid_retry_count")
  })
})
