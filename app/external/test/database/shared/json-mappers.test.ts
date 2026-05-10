import {mapToJsonValue} from "../../../src/database/shared/json-mappers"

describe("mapToJsonValue", () => {
  it("should throw if top level value is null", () => {
    expect(() => mapToJsonValue(null)).toThrow("Value cannot be null or undefined")
  })

  it("should throw if top level value is undefined", () => {
    expect(() => mapToJsonValue(undefined)).toThrow("Value cannot be null or undefined")
  })

  it("should accept null in nested object", () => {
    const input = {a: null}
    const result = mapToJsonValue(input)
    expect(result).toEqual({a: null})
  })

  it("should accept null in nested array", () => {
    const input = {a: [null]}
    const result = mapToJsonValue(input)
    expect(result).toEqual({a: [null]})
  })

  it("should accept deeply nested null", () => {
    const input = {a: {b: [{c: null}]}}
    const result = mapToJsonValue(input)
    expect(result).toEqual({a: {b: [{c: null}]}})
  })
})
