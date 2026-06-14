import {FeatureInterface} from "unleash-client/lib/feature"

/**
 * Simplified bootstrap format for Approvio levers.
 *
 * Supports two formats:
 * 1. **Array of Strings (`string[]`)**:
 *    A shorthand for enabling specific levers.
 *    Example: `["read_only_mode", "disable_workflow_creation"]`
 *    All levers in the list will be set to `enabled: true`.
 *    Levers NOT in the list will not be defined in the bootstrap data and will
 *    rely on the system's fail-open defaults.
 *
 * 2. **Object Map (`Record<string, boolean>`)**:
 *    A more explicit format for defining the exact state of each lever.
 *    Example: `{"read_only_mode": true, "disable_workflow_creation": false}`
 *    This allows explicitly disabling a lever (overriding even potential SDK defaults)
 *    or simply being more verbose about the desired state.
 *
 * Difference:
 * The Array format is a convenience shorthand when you only care about which levers
 * should be ACTIVE. The Object format provides full control over the boolean state
 * of each individual lever.
 */
export type ApprovioLeverBootstrap = Record<string, boolean> | string[]

/**
 * Maps our simplified bootstrap format to the official Unleash FeatureInterface.
 */
export function mapToUnleashFeatures(bootstrap: ApprovioLeverBootstrap): FeatureInterface[] {
  if (Array.isArray(bootstrap))
    return bootstrap.map(name => ({
      name,
      enabled: true,
      strategies: [{name: "default", parameters: {}, constraints: []}],
      type: "operational"
    }))

  return Object.entries(bootstrap).map(([name, enabled]) => ({
    name,
    enabled,
    strategies: [{name: "default", parameters: {}, constraints: []}],
    type: "operational"
  }))
}
