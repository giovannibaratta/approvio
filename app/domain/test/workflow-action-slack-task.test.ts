import {WorkflowActionSlackTaskFactory} from "../src/workflow-tasks/slack-task"

describe("Slack webhook destination", () => {
  it("accepts a Slack HTTPS webhook", () => {
    expect(WorkflowActionSlackTaskFactory.isValidSlackWebhookUrl("https://hooks.slack.com/services/example")).toBe(true)
  })

  it.each([
    "http://hooks.slack.com/services/example",
    "https://hooks.slack.com:444/services/example",
    "https://hooks.slack.com.example.com/services/example",
    "https://user@hooks.slack.com/services/example"
  ])("rejects a destination outside the Slack webhook policy", destination => {
    expect(WorkflowActionSlackTaskFactory.isValidSlackWebhookUrl(destination)).toBe(false)
  })
})
