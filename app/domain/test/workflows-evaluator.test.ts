import {
  evaluateWorkflowStatus,
  WorkflowStatus,
  WorkflowFactory,
  WorkflowTemplateFactory,
  ApprovalRuleType,
  Vote,
  DecoratedWorkflow,
  EntityReference
} from "@domain"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {unwrapRight} from "@utils/either"

describe("Workflow Status Evaluator (Chronological)", () => {
  const groupId1 = uuidv7()
  const userId1 = uuidv7()
  const userId2 = uuidv7()
  const workflowTemplateId = uuidv7()

  const voter1: EntityReference = {entityId: userId1, entityType: "user"}
  const voter2: EntityReference = {entityId: userId2, entityType: "user"}

  let decoratedWorkflow: DecoratedWorkflow<{workflowTemplate: true}>

  beforeEach(() => {
    const templateResult = unwrapRight(
      WorkflowTemplateFactory.newWorkflowTemplate({
        name: "Test Template",
        description: "A test template",
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: groupId1,
          minCount: 1
        },
        actions: [],
        spaceId: uuidv7()
      })
    )

    const template = {
      ...templateResult,
      id: workflowTemplateId,
      occ: 1n
    }

    const workflowResult = unwrapRight(
      WorkflowFactory.newWorkflow({
        name: "Test-Workflow",
        description: "Test description",
        workflowTemplateId: template.id,
        expiresAt: new Date(Date.now() + 3600 * 1000)
      })
    )

    decoratedWorkflow = {
      ...workflowResult,
      workflowTemplate: template
    }
  })

  describe("Sequential Chronological Evaluation", () => {
    it("should approve the workflow if approval criteria is met at t1, ignoring a subsequent veto at t2", () => {
      // Given
      const t1 = new Date(2026, 5, 23, 10, 0, 0)
      const t2 = new Date(2026, 5, 23, 10, 0, 5) // 5 seconds later

      const approvalVote: Vote = {
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: voter1,
        type: "APPROVE",
        votedForGroups: [groupId1],
        castedAt: t1
      }

      const vetoVote: Vote = {
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: voter2,
        type: "VETO",
        castedAt: t2
      }

      // When: Evaluator processes all votes together
      const resultEither = evaluateWorkflowStatus(decoratedWorkflow, [vetoVote, approvalVote])

      // Then: Workflow is APPROVED because the terminal status APPROVED was reached first at t1
      expect(resultEither).toBeRight()
      const result = unwrapRight(resultEither)
      expect(result.status).toBe(WorkflowStatus.APPROVED)
    })

    it("should prioritize VETO over APPROVE if they have identical timestamps", () => {
      // Given: both cast votes at the exact same millisecond
      const t1 = new Date(2026, 5, 23, 10, 0, 0)

      const approvalVote: Vote = {
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: voter1,
        type: "APPROVE",
        votedForGroups: [groupId1],
        castedAt: t1
      }

      const vetoVote: Vote = {
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: voter2,
        type: "VETO",
        castedAt: t1
      }

      // When: Evaluator processes both
      const resultEither = evaluateWorkflowStatus(decoratedWorkflow, [approvalVote, vetoVote])

      // Then: Workflow is REJECTED because VETO takes priority when timestamps match exactly
      expect(resultEither).toBeRight()
      const result = unwrapRight(resultEither)
      expect(result.status).toBe(WorkflowStatus.REJECTED)
    })

    it("should allow a Veto to be resurrected if the same voter subsequently withdraws it in the timeline", () => {
      // Given: Veto is cast first at t1, then withdrawn at t2
      const t1 = new Date(2026, 5, 23, 10, 0, 0)
      const t2 = new Date(2026, 5, 23, 10, 0, 5)

      const vetoVote: Vote = {
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: voter1,
        type: "VETO",
        castedAt: t1
      }

      const withdrawVote: Vote = {
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: voter1,
        type: "WITHDRAW",
        castedAt: t2
      }

      // When: Evaluator processes both
      const resultEither = evaluateWorkflowStatus(decoratedWorkflow, [vetoVote, withdrawVote])

      // Then: Status goes back to EVALUATION_IN_PROGRESS because REJECTED is non-terminal and veto is withdrawn
      expect(resultEither).toBeRight()
      const result = unwrapRight(resultEither)
      expect(result.status).toBe(WorkflowStatus.EVALUATION_IN_PROGRESS)
    })
  })
})
