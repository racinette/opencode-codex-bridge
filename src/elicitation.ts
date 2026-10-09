import Ajv from "ajv"
import Ajv2019 from "ajv/dist/2019"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import type { ValidateFunction } from "ajv"

export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function formValidator(schema: unknown): ValidateFunction {
  if (!object(schema)) throw new Error("MCP form schema must be an object")
  const version = typeof schema.$schema === "string" ? schema.$schema : ""
  const Constructor = version.includes("2020-12")
    ? Ajv2020
    : version.includes("2019-09")
      ? Ajv2019
      : Ajv
  const ajv = new Constructor({
    allErrors: true,
    strictTypes: false,
    strictTuples: false,
    strictRequired: false,
    allowUnionTypes: true,
  })
  addFormats(ajv)
  // MCP's older titled-enum extension is display metadata, not a constraint.
  ajv.addKeyword("enumNames")
  return ajv.compile(schema)
}
export function validateForm(validate: ValidateFunction, content: unknown) {
  if (!object(content)) throw new Error("MCP form content must be an object")
  if (!validate(content))
    throw new Error(
      "Invalid MCP form: " +
        validate.errors
          ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
          .join("; "),
    )
  return content
}
