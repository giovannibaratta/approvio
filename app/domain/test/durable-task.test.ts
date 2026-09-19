import {TaskStateMachine} from "@domain"

describe("durable task domain", () => {
  it("rejects unsafe task state jumps", () => {
    expect(TaskStateMachine.transition("ready", "claimed")).toBeRightOf("claimed")
    expect(TaskStateMachine.transition("claimed", "sending")).toBeRightOf("sending")
    expect(TaskStateMachine.transition("sending", "succeeded")).toBeRightOf("succeeded")
    expect(TaskStateMachine.transition("ready", "succeeded")).toBeLeftOf("task_invalid_transition")
    expect(TaskStateMachine.transition("succeeded", "claimed")).toBeLeftOf("task_invalid_transition")
  })
})
