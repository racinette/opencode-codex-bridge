import { expect, test } from "bun:test"
import { formValidator, validateForm } from "../src/elicitation"

test("MCP schema constraints validate typed values without coercion or silently dropping fields", () => {
  const validate = formValidator({
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      count: { type: "integer", minimum: 1, maximum: 5 },
      tags: {
        type: "array",
        items: { enum: ["a", "b"] },
        minItems: 1,
        uniqueItems: true,
      },
      enabled: { type: "boolean" },
    },
    required: ["email", "count", "enabled"],
    additionalProperties: false,
  })
  const valid = {
    email: "x@example.com",
    count: 2,
    enabled: false,
    tags: ["a"],
  }
  expect(validateForm(validate, valid)).toBe(valid)
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, count: "2" },
    { ...valid, count: 1.5 },
    { ...valid, enabled: "false" },
    { ...valid, email: "invalid" },
    { ...valid, tags: ["a", "a"] },
    { ...valid, extra: 1 },
  ])
    expect(() => validateForm(validate, invalid)).toThrow()
  expect(valid).toEqual({
    email: "x@example.com",
    count: 2,
    enabled: false,
    tags: ["a"],
  })
})

test("native OpenAI form schemas support nested objects and current JSON Schema dialects", () => {
  for (const $schema of [
    "http://json-schema.org/draft-07/schema#",
    "https://json-schema.org/draft/2019-09/schema",
    "https://json-schema.org/draft/2020-12/schema",
  ]) {
    const validate = formValidator({
      $schema,
      type: "object",
      properties: {
        account: {
          type: "object",
          properties: { id: { type: "integer" } },
          required: ["id"],
        },
        color: {
          type: "string",
          enum: ["red", "blue"],
          enumNames: ["Red", "Blue"],
        },
      },
      required: ["account"],
    })
    expect(
      validateForm(validate, { account: { id: 1 }, color: "blue" }),
    ).toEqual({ account: { id: 1 }, color: "blue" })
    expect(() => validateForm(validate, { account: { id: "1" } })).toThrow()
  }
})

test("unsupported schemas fail closed rather than submitting an unvalidated form", () => {
  for (const schema of [
    null,
    [],
    { type: "object", unknownConstraint: true },
    {
      type: "object",
      properties: { x: { type: "string", format: "unknown-format" } },
    },
  ])
    expect(() => formValidator(schema)).toThrow()
})
