/**
 * # Quota System
 *
 * The Approvio Quota System implements a hierarchical limit enforcement mechanism.
 *
 * ## Hierarchical Configuration
 * Quotas can be configured at multiple levels in the resource hierarchy. A limit for a specific
 * quotaType can be set directly on the resource where it applies (the "Evaluation Level") or
 * inherited from any of its ancestors.
 *
 * For example, a limit for `MAX_WORKFLOW_TEMPLATES_PER_SPACE` can be defined:
 * 1. At the `Space` level: Setting a specific limit for a particular space.
 * 2. At the `Org` level: Setting a default limit for all spaces within that organization.
 *
 * ## Evaluation Logic
 * While a quota can be *set* at multiple levels, the *evaluation* is always determined at the
 * specific level for which the quotaType applies. When checking usage, the system resolves the
 * effective limit by traversing up the hierarchy starting from the resource being evaluated
 * and picking the first (most specific) defined quota.
 */
import {PrefixUnion} from "@utils"
import {v4 as uuid} from "uuid"
import {isObject, isUUIDv4} from "@utils/validation"
import * as E from "fp-ts/Either"
import {DescendantsOf, getParentsOfType, isNodeType, Node, NodeAtOrAbove, NodeType} from "./hierarchy"

/**
 * Defines the base {@link NodeType} for each {@link SupportedQuotaType}.
 *
 * This mapping determines both the semantic meaning and the valid configuration scope of a quota:
 *
 * 1. **Base Level**: The node type where the metric is actually measured (the "Evaluation Level").
 * 2. **Inheritance**: A quota can be defined at its base level or at any of its transitive parents.
 *    When defined on an ancestor, it is inherited as a default by all nodes of the base level
 *    within that ancestor's subtree, unless overridden by a more specific definition.
 * 3. **Invalidity**: A quota has no semantic meaning for descendants of its base level.
 *    For example, `MAX_WORKFLOW_TEMPLATES_PER_SPACE` cannot be defined on a `Workflow`.
 */
const QUOTA_TYPE_NODE_MAPPING = {
  MAX_CONCURRENT_WORKFLOWS: "WorkflowTemplate",
  MAX_ENTITIES_PER_GROUP: "Group",
  MAX_WORKFLOW_TEMPLATES_PER_SPACE: "Space",
  MAX_GROUPS: "Org",
  MAX_ROLES_PER_USER: "User",
  MAX_SPACES: "Org",
  MAX_VOTES_PER_WORKFLOW: "Workflow"
} as const satisfies Record<string, NodeType>

export type SupportedQuotaType = keyof typeof QUOTA_TYPE_NODE_MAPPING

/**
 * Derive all quotaType associated with a NodeType and its descendants.
 * A quotaType can be defined at NodeType T if it's supported by T or any of its descendants.
 */
type SupportedQuotaTypesFor<T extends NodeType> = {
  [K in SupportedQuotaType]: (typeof QUOTA_TYPE_NODE_MAPPING)[K] extends DescendantsOf<T> ? K : never
}[SupportedQuotaType]

function getLowestNodeTypeForQuotaType(quotaType: SupportedQuotaType): NodeType {
  return QUOTA_TYPE_NODE_MAPPING[quotaType]
}

/* ----------------------------------- */

/**
 * Generic identifier for a quota, mapping a node to a quotaType it supports.
 * This creates a union of all possible quota types by iterating over each NodeType.
 */
export type QuotaIdentifier = {
  [K in NodeType]: {
    node: NodeAtOrAbove<K>
    quotaType: SupportedQuotaTypesFor<K>
  }
}[NodeType]

export type Quota = QuotaIdentifier & {
  readonly id: string
  readonly limit: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type QuotaValidationError = PrefixUnion<
  "quota",
  | "invalid_id"
  | "malformed_quota"
  | "invalid_scope"
  | "invalid_quota_type"
  | "unsupported_node_type"
  | "invalid_limit"
  | "missing_target_id"
  | "invalid_target_id"
>

function isSupportedQuotaType(val: string): val is SupportedQuotaType {
  return val in QUOTA_TYPE_NODE_MAPPING
}

export type QuotaIdentifierValidationError = PrefixUnion<
  "quota",
  | "malformed_identifier"
  | "invalid_quota_type"
  | "invalid_node_type"
  | "unsupported_node_type"
  | "invalid_target_id"
  | "invalid_format"
  | "unsupported_quota_type"
>

/**
 * Checks if a quotaType is valid for a given node type.
 * A quotaType is valid if the node type is exactly the base level or one of its parents.
 */
function isQuotaSupportedAt(quotaType: SupportedQuotaType, type: NodeType): boolean {
  const lowestSupportedType = getLowestNodeTypeForQuotaType(quotaType)
  return type === lowestSupportedType || getParentsOfType(lowestSupportedType).includes(type)
}

/**
 * Checks if a quotaType is applicable to a given node type.
 * A quotaType is applicable if the node type is exactly the base level where usage is measured.
 */
export function isQuotaTypeApplicableTo(quotaType: SupportedQuotaType, type: NodeType): boolean {
  return type === QUOTA_TYPE_NODE_MAPPING[quotaType]
}

export class QuotaIdentifierFactory {
  static fromNodeAndQuota(
    node: Node,
    quotaType: SupportedQuotaType
  ): E.Either<QuotaIdentifierValidationError, QuotaIdentifier> {
    return this.validate({node, quotaType})
  }

  static validate(data: unknown): E.Either<QuotaIdentifierValidationError, QuotaIdentifier> {
    if (!isObject(data)) return E.left("quota_invalid_format")

    const {node, quotaType} = data

    if (!isObject(node)) return E.left("quota_invalid_format")
    const nodeData = node

    if (typeof nodeData.type !== "string" || !isNodeType(nodeData.type)) return E.left("quota_invalid_node_type")
    if (typeof nodeData.identifier !== "string" || !isUUIDv4(nodeData.identifier))
      return E.left("quota_invalid_target_id")

    if (typeof quotaType !== "string" || !isSupportedQuotaType(quotaType)) return E.left("quota_unsupported_quota_type")

    if (!isQuotaSupportedAt(quotaType, nodeData.type)) return E.left("quota_unsupported_node_type")

    return E.right({
      node: {
        type: nodeData.type,
        identifier: nodeData.identifier
      },
      quotaType
    } as QuotaIdentifier)
  }
}

export class QuotaFactory {
  static validate(data: unknown): E.Either<QuotaValidationError, Quota> {
    if (!isObject(data)) return E.left("quota_malformed_quota")

    const identifierEither = QuotaIdentifierFactory.validate(data)
    if (E.isLeft(identifierEither)) return E.left("quota_malformed_quota")

    if (typeof data.id !== "string") return E.left("quota_malformed_quota")
    if (!isUUIDv4(data.id)) return E.left("quota_invalid_id")

    if (typeof data.limit !== "number" || !Number.isInteger(data.limit) || data.limit < 0)
      return E.left("quota_invalid_limit")

    if (!(data.createdAt instanceof Date)) return E.left("quota_malformed_quota")
    if (!(data.updatedAt instanceof Date)) return E.left("quota_malformed_quota")

    return E.right({
      id: data.id,
      node: identifierEither.right.node,
      quotaType: identifierEither.right.quotaType,
      limit: data.limit,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt
    } as Quota)
  }

  static newQuota(data: object, limit: number): E.Either<QuotaValidationError, Quota> {
    const now = new Date()

    return this.validate({
      id: uuid(),
      ...data,
      limit,
      updatedAt: now,
      createdAt: now
    })
  }
}
