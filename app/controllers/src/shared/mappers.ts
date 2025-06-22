import {ApprovalRuleData, ApprovalRuleType} from "@domain"
import {ApprovalRule as ApprovalRuleApi} from "@approvio/api"

/** Map the domain model to the API model */
export function mapApprovalRuleDataToApi(rule: ApprovalRuleData): ApprovalRuleApi {
  switch (rule.type) {
    case ApprovalRuleType.GROUP_REQUIREMENT:
      return {
        type: rule.type,
        groupId: rule.groupId,
        minCount: rule.minCount
      }
    case ApprovalRuleType.AND:
      return {
        type: rule.type,
        rules: rule.rules.map(mapApprovalRuleDataToApi)
      }
    case ApprovalRuleType.OR:
      return {
        type: rule.type,
        rules: rule.rules.map(mapApprovalRuleDataToApi)
      }
  }
}
