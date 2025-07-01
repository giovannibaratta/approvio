import {isUUIDv4, PrefixUnion} from "@utils"
import * as E from "fp-ts/Either"
import {Either, left, right} from "fp-ts/lib/Either"
import {pipe} from "fp-ts/lib/function"
import * as A from "fp-ts/Array"
import {ApproveVote} from "@domain"

export enum ApprovalRuleType {
  AND = "AND",
  OR = "OR",
  GROUP_REQUIREMENT = "GROUP_REQUIREMENT"
}

export type ApprovalRule = ApprovalRuleData & ApprovalRuleLogic

export type ApprovalRuleData = AndRule | OrRule | GroupRequirementRule

export type GroupRequirementRule = Readonly<PrivateGroupRequirementRule>

interface PrivateGroupRequirementRule {
  type: ApprovalRuleType.GROUP_REQUIREMENT
  groupId: string
  minCount: number
}

export type AndRule = Readonly<PrivateAndRule>
interface PrivateAndRule {
  type: ApprovalRuleType.AND
  rules: ReadonlyArray<ApprovalRule>
}

export type OrRule = Readonly<PrivateOrRule>
interface PrivateOrRule {
  type: ApprovalRuleType.OR
  rules: ReadonlyArray<ApprovalRule>
}

interface ApprovalRuleLogic {
  /**
   * Return the voting group ids that are part of the approval rule. Also nested rules are considered.
   * @returns The voting group ids.
   */
  getVotingGroupIds(): ReadonlyArray<string>
}

export type ApprovalRuleValidationError = PrefixUnion<"approval_rule", UnprefixedApprovalRuleValidationError>

type UnprefixedApprovalRuleValidationError =
  | "malformed_content"
  | "invalid_rule_type"
  | "and_rule_must_have_rules"
  | "or_rule_must_have_rules"
  | "group_rule_invalid_min_count"
  | "group_rule_invalid_group_id"
  | "max_rule_nesting_exceeded"

const MAX_NESTING_DEPTH = 2

export class ApprovalRuleFactory {
  /**
   * Validates a raw object structure against the ApprovalRules domain model.
   * This function handles the discriminated union and recursively validates nested rules.
   * @param data The raw object to validate.
   * @returns Either a validation error or the valid ApprovalRules object.
   */
  static validate(data: unknown): Either<ApprovalRuleValidationError, ApprovalRule> {
    const rule = this.validateApprovalRuleData(data, 0)
    return E.isRight(rule) ? right(this.decorateApprovalRuleData(rule.right)) : rule
  }

  private static validateApprovalRuleData(data: unknown, depth = 0): Either<ApprovalRuleValidationError, ApprovalRule> {
    if (depth > MAX_NESTING_DEPTH) return left("approval_rule_max_rule_nesting_exceeded")
    if (!isObject(data) || typeof data.type !== "string") return left("approval_rule_invalid_rule_type")

    switch (data.type) {
      case ApprovalRuleType.GROUP_REQUIREMENT:
        return pipe(this.validateGroupRequirementRule(data), E.map(this.decorateApprovalRuleData))
      case ApprovalRuleType.AND:
        return pipe(this.validateAndRule(data, depth), E.map(this.decorateApprovalRuleData))
      case ApprovalRuleType.OR:
        return pipe(this.validateOrRule(data, depth), E.map(this.decorateApprovalRuleData))
      default:
        return left("approval_rule_invalid_rule_type")
    }
  }

  private static validateGroupRequirementRule(
    data: Record<string, unknown>
  ): Either<ApprovalRuleValidationError, GroupRequirementRule> {
    if (typeof data.groupId !== "string") return left("approval_rule_group_rule_invalid_group_id")
    if (!isUUIDv4(data.groupId)) return left("approval_rule_group_rule_invalid_group_id")
    if (typeof data.minCount !== "number" || !Number.isInteger(data.minCount))
      return left("approval_rule_group_rule_invalid_min_count")
    if (data.minCount < 1) return left("approval_rule_group_rule_invalid_min_count")

    return right({
      type: ApprovalRuleType.GROUP_REQUIREMENT,
      groupId: data.groupId,
      minCount: data.minCount
    })
  }

  private static validateAndRule(
    data: Record<string, unknown>,
    depth: number
  ): Either<ApprovalRuleValidationError, AndRule> {
    if (!Array.isArray(data.rules) || data.rules.length === 0) return left("approval_rule_and_rule_must_have_rules")

    return pipe(
      data.rules,
      A.traverse(E.Applicative)(rule => ApprovalRuleFactory.validateApprovalRuleData(rule, depth + 1)),
      E.map(rules => ({type: ApprovalRuleType.AND, rules}))
    )
  }

  private static validateOrRule(
    data: Record<string, unknown>,
    depth: number
  ): Either<ApprovalRuleValidationError, OrRule> {
    if (!Array.isArray(data.rules) || data.rules.length === 0) {
      return left("approval_rule_or_rule_must_have_rules")
    }

    return pipe(
      data.rules,
      A.traverse(E.Applicative)(rule => ApprovalRuleFactory.validateApprovalRuleData(rule, depth + 1)),
      E.map(rules => ({type: ApprovalRuleType.OR, rules}))
    )
  }

  private static decorateApprovalRuleData(data: ApprovalRuleData): ApprovalRule {
    return {
      ...data,
      getVotingGroupIds: () => getVotingGroupIds(data)
    }
  }
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val)
}

/**
 * Checks if the given votes cover the given approval rule.
 * @param rule The approval rule to check.
 * @param votes The votes to check.
 * @returns True if the votes cover the rule, false otherwise.
 */
export function doesVotesCoverApprovalRules(rule: ApprovalRuleData, votes: ReadonlyArray<ApproveVote>): boolean {
  switch (rule.type) {
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return doesVotesCoverGroupRequirementRule(rule, votes)
    case ApprovalRuleType.AND:
      return rule.rules.every(rule => doesVotesCoverApprovalRules(rule, votes))
    case ApprovalRuleType.OR:
      return rule.rules.some(rule => doesVotesCoverApprovalRules(rule, votes))
  }
}

function doesVotesCoverGroupRequirementRule(rule: GroupRequirementRule, votes: ReadonlyArray<ApproveVote>): boolean {
  const votesForGroup = votes.filter(vote => vote.votedForGroups.includes(rule.groupId))
  const uniqueUsersWhoVotedForGroup = new Set(votesForGroup.map(vote => vote.userId))
  return uniqueUsersWhoVotedForGroup.size >= rule.minCount
}

function getVotingGroupIds(rule: ApprovalRuleData): ReadonlyArray<string> {
  switch (rule.type) {
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return [rule.groupId]
    case ApprovalRuleType.AND:
      return rule.rules.flatMap(getVotingGroupIds)
    case ApprovalRuleType.OR:
      return rule.rules.flatMap(getVotingGroupIds)
  }
}
