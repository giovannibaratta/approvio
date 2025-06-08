import {VoteFactory, consolidateVotes, Vote, ApproveVote} from "@domain"
import {randomUUID} from "crypto"
import {addSecondsToDate} from "@utils/date"

describe("Vote", () => {
  describe("VoteFactory", () => {
    const validVoteInput: Parameters<typeof VoteFactory.newVote>[0] = {
      workflowId: randomUUID(),
      userId: randomUUID(),
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
          expect(result).toBeLeftOf("invalid_workflow_id")
        })

        it("should return invalid_user_id if userId is not a UUID", () => {
          const vote: Vote = {
            id: randomUUID(),
            castedAt: new Date(),
            ...validVoteInput,
            userId: "not-a-uuid"
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("invalid_user_id")
        })

        it("should return reason_too_long if reason is too long", () => {
          const vote: Vote = {
            id: randomUUID(),
            castedAt: new Date(),
            ...validVoteInput,
            reason: "a".repeat(1025)
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("reason_too_long")
        })

        it("should return invalid_group_id if a groupId is not a UUID for an APPROVE vote", () => {
          const vote: ApproveVote = {
            id: randomUUID(),
            castedAt: new Date(),
            type: "APPROVE",
            workflowId: randomUUID(),
            userId: randomUUID(),
            votedForGroups: ["not-a-uuid"]
          }
          const result = VoteFactory.validate(vote)
          expect(result).toBeLeftOf("invalid_group_id")
        })
      })
    })
  })

  describe("consolidateVotes", () => {
    const userId1 = randomUUID()
    const userId2 = randomUUID()
    const workflowId = randomUUID()
    const groupId1 = randomUUID()

    const createVote = (
      userId: string,
      type: "APPROVE" | "VETO" | "WITHDRAW",
      castedAt: Date,
      votedForGroups: string[] = []
    ): Vote => {
      if (type === "APPROVE") {
        return {
          id: randomUUID(),
          workflowId,
          userId,
          type,
          castedAt,
          votedForGroups
        }
      }
      return {id: randomUUID(), workflowId, userId, type, castedAt}
    }

    it("should keep only the most recent non-withdraw vote for each user", () => {
      // Given
      const now = new Date()
      const oldVoteUserId1 = createVote(userId1, "APPROVE", now, [groupId1])
      const recentVoteUserId1 = createVote(userId1, "APPROVE", addSecondsToDate(now, 1), [groupId1])
      const recentVoteUserId2 = createVote(userId2, "APPROVE", addSecondsToDate(now, 1), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, recentVoteUserId1, recentVoteUserId2]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(2)
      expect(consolidated.find(v => v.userId === userId1)?.id).toEqual(recentVoteUserId1.id)
      expect(consolidated.find(v => v.userId === userId2)?.id).toEqual(recentVoteUserId2.id)
    })

    it("should discard all votes previous to a VETO and keep the most recent vote for a user", () => {
      // Given
      const now = new Date()
      const oldVoteUserId1 = createVote(userId1, "APPROVE", now, [groupId1])
      const vetoVoteUserId1 = createVote(userId1, "VETO", addSecondsToDate(now, 1), [groupId1])
      const postVetoUserId1 = createVote(userId1, "APPROVE", addSecondsToDate(now, 2), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, vetoVoteUserId1, postVetoUserId1]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(1)
      expect(consolidated.find(v => v.userId === userId1)?.id).toEqual(postVetoUserId1.id)
    })

    it("should discard all previous votes for a user if they have a WITHDRAW vote", () => {
      // Given
      const now = new Date()
      const oldVoteUserId1 = createVote(userId1, "APPROVE", now, [groupId1])
      const withdrawVoteUserId1 = createVote(userId1, "WITHDRAW", addSecondsToDate(now, 1), [groupId1])
      const recentVoteUserId2 = createVote(userId2, "APPROVE", addSecondsToDate(now, 2), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, withdrawVoteUserId1, recentVoteUserId2]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(1)
      expect(consolidated.find(v => v.userId === userId1)).toEqual(undefined)
    })

    it("should return an empty array if all votes are withdrawn", () => {
      // Given
      const now = new Date()
      const oldVoteUserId1 = createVote(userId1, "APPROVE", now, [groupId1])
      const withdrawVoteUserId1 = createVote(userId1, "WITHDRAW", addSecondsToDate(now, 1), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, withdrawVoteUserId1]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(0)
    })

    it("should return only the veto vote for a user if they have a veto vote", () => {
      // Given
      const now = new Date()
      const oldVoteUserId1 = createVote(userId1, "APPROVE", now, [groupId1])
      const oldVote2UserId1 = createVote(userId1, "APPROVE", addSecondsToDate(now, 1), [groupId1])
      const vetoVoteUserId1 = createVote(userId1, "VETO", addSecondsToDate(now, 2), [groupId1])
      const votes: Vote[] = [oldVoteUserId1, oldVote2UserId1, vetoVoteUserId1]

      // When
      const consolidated = consolidateVotes(votes)

      // Expect
      expect(consolidated).toHaveLength(1)
      expect(consolidated.find(v => v.userId === userId1)?.id).toEqual(vetoVoteUserId1.id)
    })
  })
})
