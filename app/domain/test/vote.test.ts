import {VoteFactory, Vote, ApproveVote, EntityReference} from "@domain"

import {v7 as uuidv7} from "uuid"

describe("Vote", () => {
  describe("VoteFactory", () => {
    const validVoter: EntityReference = {
      entityId: uuidv7(),
      entityType: "user"
    }

    const validVoteInput: Parameters<typeof VoteFactory.newVote>[0] = {
      workflowId: uuidv7(),
      voter: validVoter,
      type: "APPROVE",
      votedForGroups: [uuidv7()]
    }

    describe("newVote", () => {
      it("should create a new vote successfully", () => {
        const result = VoteFactory.newVote(validVoteInput)
        expect(result).toBeRight()
      })
    })

    describe("validate", () => {
      describe("good cases", () => {
        it("should return a valid vote", () => {
          const vote: Vote = {
            id: uuidv7(),
            castedAt: new Date(),
            ...validVoteInput
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeRight()
        })
      })

      describe("bad cases", () => {
        it("should return invalid_workflow_id if workflowId is not a UUID", () => {
          const vote: Vote = {
            id: uuidv7(),
            castedAt: new Date(),
            ...validVoteInput,
            workflowId: "not-a-uuid"
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("vote_invalid_workflow_id")
        })

        it("should return invalid_voter_id if voter id is not a UUID", () => {
          // Given
          const vote: Vote = {
            id: uuidv7(),
            castedAt: new Date(),
            ...validVoteInput,
            voter: {entityId: "not-a-uuid", entityType: "user"}
          }

          // When
          const result = VoteFactory.validate(vote)

          // Expect
          expect(result).toBeLeftOf("vote_invalid_voter_id")
        })

        it("should return invalid_voter_type if voter type is invalid", () => {
          const vote: Vote = {
            id: uuidv7(),
            castedAt: new Date(),
            ...validVoteInput,
            voter: {entityId: uuidv7(), entityType: "invalid" as EntityReference["entityType"]}
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("vote_invalid_voter_type")
        })

        it("should return reason_too_long if reason is too long", () => {
          const vote: Vote = {
            id: uuidv7(),
            castedAt: new Date(),
            ...validVoteInput,
            reason: "a".repeat(1025)
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("vote_reason_too_long")
        })

        it("should return invalid_group_id if a groupId is not a UUID for an APPROVE vote", () => {
          const vote: ApproveVote = {
            id: uuidv7(),
            castedAt: new Date(),
            type: "APPROVE",
            workflowId: uuidv7(),
            voter: validVoter,
            votedForGroups: ["not-a-uuid"]
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("vote_invalid_group_id")
        })
      })
    })
  })
})
