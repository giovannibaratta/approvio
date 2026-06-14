import {mapToUnleashFeatures} from "../../src/config/lever-bootstrap.utils"
import {FeatureInterface} from "unleash-client/lib/feature"

describe("lever-bootstrap.utils", () => {
  describe("mapToUnleashFeatures", () => {
    it("should map array of strings to enabled features", () => {
      const bootstrap = ["read_only_mode", "disable_workflow_creation"]
      const result = mapToUnleashFeatures(bootstrap)

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual({
        name: "read_only_mode",
        enabled: true,
        strategies: [{name: "default", parameters: {}, constraints: []}],
        type: "operational"
      })
      expect(result[1]).toEqual({
        name: "disable_workflow_creation",
        enabled: true,
        strategies: [{name: "default", parameters: {}, constraints: []}],
        type: "operational"
      })
    })

    it("should map object map to features with explicit enabled state", () => {
      const bootstrap = {
        read_only_mode: true,
        disable_workflow_creation: false
      }
      const result = mapToUnleashFeatures(bootstrap)

      expect(result).toHaveLength(2)
      expect(result.find((f: FeatureInterface) => f.name === "read_only_mode")?.enabled).toBe(true)
      expect(result.find((f: FeatureInterface) => f.name === "disable_workflow_creation")?.enabled).toBe(false)

      const firstFeature = result[0]
      expect(firstFeature?.strategies).toEqual([{name: "default", parameters: {}, constraints: []}])
      expect(firstFeature?.type).toBe("operational")
    })

    it("should return empty array for empty input", () => {
      expect(mapToUnleashFeatures([])).toHaveLength(0)
      expect(mapToUnleashFeatures({})).toHaveLength(0)
    })
  })
})
