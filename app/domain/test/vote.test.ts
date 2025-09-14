import {VoteFactory, consolidateVotes, Vote, ApproveVote, EntityReference} from "@domain"
import {randomUUID} from "crypto"
import {addSecondsToDate} from "@utils/date"

describe("Vote", () => {
  describe("VoteFactory", () => {
    const validVoter: EntityReference = {
      entityId: randomUUID(),
      entityType: "user"
    }

    const validVoteInput: Parameters<typeof VoteFactory.newVote>[0] = {
      workflowId: randomUUID(),
      voter: validVoter,
      type: "APPROVE",
      votedForGroups: [randomUUID()]
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
            id: randomUUID(),
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
            id: randomUUID(),
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
            id: randomUUID(),
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
            id: randomUUID(),
            castedAt: new Date(),
            ...validVoteInput,
            voter: {entityId: randomUUID(), entityType: "invalid" as EntityReference["entityType"]}
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("vote_invalid_voter_type")
        })

        it("should return reason_too_long if reason is too long", () => {
          const vote: Vote = {
            id: randomUUID(),
            castedAt: new Date(),
            ...validVoteInput,
            reason: "a".repeat(1025)
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("vote_reason_too_long")
        })

        it("should return invalid_group_id if a groupId is not a UUID for an APPROVE vote", () => {
          const vote: ApproveVote = {
            id: randomUUID(),
            castedAt: new Date(),
            type: "APPROVE",
            workflowId: randomUUID(),
            voter: validVoter,
            votedForGroups: ["not-a-uuid"]
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("vote_invalid_group_id")
        })
      })
    })
  })

  describe("consolidateVotes", () => {
    const userId1 = randomUUID()
    const userId2 = randomUUID()
    const agentId1 = randomUUID()
    const workflowId = randomUUID()
    const groupId1 = randomUUID()

    const createVote = (
      voter: EntityReference,
      type: "APPROVE" | "VETO" | "WITHDRAW",
      castedAt: Date,
      votedForGroups: string[] = []
    ): Vote => {
      if (type === "APPROVE") {
        return {
          id: randomUUID(),
          workflowId,
          voter,
          type,
          castedAt,
          votedForGroups
        }
      }
      return {id: randomUUID(), workflowId, voter, type, castedAt}
    }

    it("should keep only the most recent non-withdraw vote for each voter", () => {
      // Given
      const now = new Date()
      const voter1: EntityReference = {entityId: userId1, entityType: "user"}
      const voter2: EntityReference = {entityId: userId2, entityType: "user"}
      const oldVoteUserId1 = createVote(voter1, "APPROVE", now, [groupId1])
      const recentVoteUserId1 = createVote(voter1, "APPROVE", addSecondsToDate(now, 1), [groupId1])
      const recentVoteUserId2 = createVote(voter2, "APPROVE", addSecondsToDate(now, 1), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, recentVoteUserId1, recentVoteUserId2]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(2)
      expect(consolidated.find(v => v.voter.entityId === userId1)?.id).toEqual(recentVoteUserId1.id)
      expect(consolidated.find(v => v.voter.entityId === userId2)?.id).toEqual(recentVoteUserId2.id)
    })

    it("should discard all votes previous to a VETO and keep the most recent vote for a voter", () => {
      // Given
      const now = new Date()
      const voter1: EntityReference = {entityId: userId1, entityType: "user"}
      const oldVoteUserId1 = createVote(voter1, "APPROVE", now, [groupId1])
      const vetoVoteUserId1 = createVote(voter1, "VETO", addSecondsToDate(now, 1), [groupId1])
      const postVetoUserId1 = createVote(voter1, "APPROVE", addSecondsToDate(now, 2), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, vetoVoteUserId1, postVetoUserId1]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(1)
      expect(consolidated.find(v => v.voter.entityId === userId1)?.id).toEqual(postVetoUserId1.id)
    })

    it("should discard all previous votes for a voter if they have a WITHDRAW vote", () => {
      // Given
      const now = new Date()
      const voter1: EntityReference = {entityId: userId1, entityType: "user"}
      const voter2: EntityReference = {entityId: userId2, entityType: "user"}
      const oldVoteUserId1 = createVote(voter1, "APPROVE", now, [groupId1])
      const withdrawVoteUserId1 = createVote(voter1, "WITHDRAW", addSecondsToDate(now, 1), [groupId1])
      const recentVoteUserId2 = createVote(voter2, "APPROVE", addSecondsToDate(now, 2), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, withdrawVoteUserId1, recentVoteUserId2]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(1)
      expect(consolidated.find(v => v.voter.entityId === userId1)).toEqual(undefined)
    })

    it("should return an empty array if all votes are withdrawn", () => {
      // Given
      const now = new Date()
      const voter1: EntityReference = {entityId: userId1, entityType: "user"}
      const oldVoteUserId1 = createVote(voter1, "APPROVE", now, [groupId1])
      const withdrawVoteUserId1 = createVote(voter1, "WITHDRAW", addSecondsToDate(now, 1), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, withdrawVoteUserId1]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(0)
    })

    it("should return only the veto vote for a voter if they have a veto vote", () => {
      // Given
      const now = new Date()
      const voter1: EntityReference = {entityId: userId1, entityType: "user"}
      const oldVoteUserId1 = createVote(voter1, "APPROVE", now, [groupId1])
      const oldVote2UserId1 = createVote(voter1, "APPROVE", addSecondsToDate(now, 1), [groupId1])
      const vetoVoteUserId1 = createVote(voter1, "VETO", addSecondsToDate(now, 2), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, oldVote2UserId1, vetoVoteUserId1]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(1)
      expect(consolidated.find(v => v.voter.entityId === userId1)?.id).toEqual(vetoVoteUserId1.id)
    })

    it("should consolidate votes from both users and agents correctly", () => {
      // Given
      const now = new Date()
      const userVoter: EntityReference = {entityId: userId1, entityType: "user"}
      const agentVoter: EntityReference = {entityId: agentId1, entityType: "agent"}
      const userVote = createVote(userVoter, "APPROVE", now, [groupId1])
      const agentVote = createVote(agentVoter, "VETO", addSecondsToDate(now, 1))
      const votes: Vote[] = [userVote, agentVote]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(2)
      expect(consolidated.find(v => v.voter.entityType === "user")?.id).toEqual(userVote.id)
      expect(consolidated.find(v => v.voter.entityType === "agent")?.id).toEqual(agentVote.id)
    })
  })
})
