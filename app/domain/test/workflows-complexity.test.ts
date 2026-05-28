/**
 * @file workflows-complexity.test.ts
 * @description Complexity tests for the Workflow Evaluation logic.
 *
 * SCOPE:
 * This test suite measures the algorithmic complexity (number of operations) performed
 * by the `evaluateWorkflowStatus` function. It establishes a "Complexity Guard" to ensure
 * that optimizations (like O(N) incremental tracking) are preserved and that future
 * changes do not re-introduce O(N^2) bottlenecks.
 *
 * REASON:
 * Workflow evaluation is a performance-critical path. In environments with many votes,
 * an O(N^2) evaluation could lead to high latency. These
 * tests verify complexity by spying on internal domain logic calls rather than measuring
 * wall-clock time, providing a deterministic way to verify efficiency.
 */

import {
  evaluateWorkflowStatus,
  WorkflowFactory,
  WorkflowTemplateFactory,
  ApprovalRuleType,
  Vote,
  DecoratedWorkflow
} from "@domain"
import * as ApprovalRules from "../src/approval-rules"
import {v7 as uuidv7} from "uuid"
import "@utils/matchers"
import {unwrapRight} from "@utils/either"

describe("Workflow Evaluation Complexity", () => {
  const groupId1 = uuidv7()
  const workflowTemplateId = uuidv7()

  let decoratedWorkflow: DecoratedWorkflow<{workflowTemplate: true}>

  beforeEach(() => {
    const templateResult = unwrapRight(
      WorkflowTemplateFactory.newWorkflowTemplate({
        name: "Complexity Template",
        description: "A template for complexity testing",
        approvalRule: {
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: groupId1,
          minCount: 100 // High enough that it doesn't break early
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
        name: "Complexity-Workflow",
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

  it("should be O(N) when the final state is NOT approved", () => {
    // Given
    const VOTE_COUNT = 50
    const votes: Vote[] = []

    for (let i = 0; i < VOTE_COUNT; i++) {
      const voterId = uuidv7()
      votes.push({
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: {entityId: voterId, entityType: "user"},
        type: "APPROVE",
        votedForGroups: [groupId1],
        castedAt: new Date(2026, 5, 23, 10, 0, i)
      })
    }

    const spy = jest.spyOn(ApprovalRules, "doesVotesCoverApprovalRules")

    // When
    evaluateWorkflowStatus(decoratedWorkflow, votes)

    // Expect
    const totalCalls = spy.mock.calls.length
    expect(totalCalls).toBe(50) // Exactly 1 call per vote
    spy.mockRestore()
  })

  it("should be O(N) when the workflow IS approved", () => {
    // Given
    const VOTE_COUNT = 50
    const votes: Vote[] = []

    // Set minCount to something achievable
    decoratedWorkflow = {
      ...decoratedWorkflow,
      workflowTemplate: {
        ...decoratedWorkflow.workflowTemplate,
        approvalRule: {
          ...decoratedWorkflow.workflowTemplate.approvalRule,
          type: ApprovalRuleType.GROUP_REQUIREMENT,
          groupId: groupId1,
          minCount: 10
        }
      }
    }

    for (let i = 0; i < VOTE_COUNT; i++) {
      const voterId = uuidv7()
      votes.push({
        id: uuidv7(),
        workflowId: decoratedWorkflow.id,
        voter: {entityId: voterId, entityType: "user"},
        type: "APPROVE",
        votedForGroups: [groupId1],
        castedAt: new Date(2026, 5, 23, 10, 0, i)
      })
    }

    const spy = jest.spyOn(ApprovalRules, "doesVotesCoverApprovalRules")

    // When
    evaluateWorkflowStatus(decoratedWorkflow, votes)

    // Expect
    const totalCalls = spy.mock.calls.length
    // Approved at step 10
    expect(totalCalls).toBe(10)
    spy.mockRestore()
  })
})
