import {getMostRecentVersionFromTuples} from "../src/workflow-templates"
import "@utils/matchers"

describe("getMostRecentVersionFromTuples", () => {
  it("should return empty_array error for an empty array", () => {
    const result = getMostRecentVersionFromTuples([])
    expect(result).toBeLeftOf("empty_array")
  })

  it("should return the single item for an array with one item", () => {
    const item = {version: 1, name: "test"}
    const result = getMostRecentVersionFromTuples([item])
    expect(result).toBeRightOf(item)
  })

  it("should return the item with the highest version", () => {
    const items = [
      {version: 1, name: "v1"},
      {version: 3, name: "v3"},
      {version: 2, name: "v2"}
    ]
    const result = getMostRecentVersionFromTuples(items)
    expect(result).toBeRightOf(items[1])
  })

  it("should handle duplicate highest versions by returning one of them (the first one found in reduce)", () => {
    const items = [
      {version: 1, name: "v1"},
      {version: 3, name: "v3a"},
      {version: 3, name: "v3b"},
      {version: 2, name: "v2"}
    ]
    const result = getMostRecentVersionFromTuples(items)
    // Current reduce: current.version > mostRecent.version ? current : mostRecent
    // For v3b, 3 > 3 is false, so it keeps v3a.
    expect(result).toBeRightOf(items[1])
  })
})
