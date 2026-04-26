/**
 * A union of all valid resource types in the Approvio system.
 *
 * These types form a hierarchy defined by {@link PARENT_MAP}, where "Org" is the root.
 */
export type NodeType = "Org" | "Group" | "Space" | "WorkflowTemplate" | "Workflow" | "User"

/**
 * Type guard to check if a string is a valid {@link NodeType}.
 */
export function isNodeType(val: string): val is NodeType {
  return ["Org", "Group", "Space", "WorkflowTemplate", "Workflow", "User"].includes(val)
}

/**
 * A generic node in the hierarchy.
 *
 * NOTE: The `T extends T` pattern is a "distributive conditional type".
 * It forces TypeScript to distribute the union `NodeType` into individual object types
 * (e.g., `{type: "Org"; ...} | {type: "Group"; ...}`) instead of a single object with
 * a union property `{type: "Org" | "Group"; ...}`.
 *
 * This is CRITICAL for `Extract<Node, ...>` and other distributive operations to work.
 */
export type Node<T extends NodeType = NodeType> = T extends T ? {type: T; identifier: string} : never

/**
 * The core definition of the Approvio resource hierarchy.
 *
 * Each key represents a node type, and its value represents its direct parent.
 * This map is the single source of truth for both runtime utilities and
 * compile-time type derivations.
 */
const PARENT_MAP = {
  Workflow: "WorkflowTemplate",
  WorkflowTemplate: "Space",
  Space: "Org",
  Group: "Org",
  User: "Org",
  Org: null
} as const satisfies Record<NodeType, NodeType | null>

/**
 * Returns an ordered array of all transitive parent {@link NodeType}s for a given type.
 *
 * The array starts with the immediate parent and ends at the root of the hierarchy (Org).
 *
 * @param type The node type to start the lookup from.
 * @returns An array of parent node types.
 */
export function getParentsOfType(type: NodeType): NodeType[] {
  let current: NodeType | null = type
  const parents: NodeType[] = []

  while (current !== null) {
    const parent: NodeType | null = PARENT_MAP[current]
    if (parent) parents.push(parent)
    current = parent
  }

  return parents
}

type ParentMap = typeof PARENT_MAP

/**
 * A compile-time utility that derives the direct child {@link NodeType}s for a given type.
 *
 * This works by inverting the {@link PARENT_MAP} at the type level.
 */
type ChildrenOf<T extends NodeType> = {
  [K in NodeType]: K extends keyof ParentMap ? (ParentMap[K] extends T ? K : never) : never
}[NodeType]

/**
 * A compile-time utility representing all {@link NodeType}s in the subtree of `T` (inclusive).
 *
 * This is unrolled for the fixed-depth hierarchy to ensure eager type resolution
 * and avoid recursion limits.
 */
export type DescendantsOf<T extends NodeType> =
  | T
  | ChildrenOf<T>
  | ChildrenOf<ChildrenOf<T>>
  | ChildrenOf<ChildrenOf<ChildrenOf<T>>>
  | ChildrenOf<ChildrenOf<ChildrenOf<ChildrenOf<T>>>>

/**
 * A compile-time utility representing all transitive parent {@link NodeType}s of `T`.
 */
export type ParentsOf<T extends NodeType> = ParentMap[T] extends NodeType
  ? ParentMap[T] | ParentsOf<ParentMap[T]>
  : never

/**
 * A node that is either of type `T` or one of its transitive parents.
 *
 * Used for hierarchical evaluation where a resource (like a Quota) can be defined
 * at the specific node level or inherited from any ancestor in the hierarchy.
 *
 * For example, `NodeAtOrAbove<"Space">` resolves to nodes of type `"Space" | "Org"`.
 */
export type NodeAtOrAbove<T extends NodeType> = Extract<Node, {type: T | ParentsOf<T>}>
