import { compileSchemaPattern } from '../tools/safeUserRegex'

/**
 * Lightweight JSON Schema checks for MCP tool args.
 * Covers required keys, primitive/object/array `type`, and common value
 * constraints (`enum`, `minLength`/`maxLength`/`pattern`, `minimum`/`maximum`,
 * `minItems`/`maxItems`) — enough to catch model mistakes before they hit the
 * MCP server. Not a full draft validator.
 */
export function validateAgainstJsonSchema(
  schema: Record<string, unknown> | undefined,
  value: unknown
): { ok: true } | { ok: false; error: string } {
  if (!schema || typeof schema !== 'object') return { ok: true }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : undefined
  const type = schema.type

  // If no type is declared, only `enum` and `properties` can constrain the
  // value, and an empty schema accepts anything.
  if (type == null) {
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
      return validateObject(schema, value, enumValues)
    }
    if (enumValues && !valueInEnum(value, enumValues)) {
      return { ok: false, error: `Expected one of: ${formatEnum(enumValues)}` }
    }
    return { ok: true }
  }

  if (type === 'object') {
    return validateObject(schema, value, enumValues)
  }
  if (type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: 'Expected a string' }
    const minLength =
      typeof schema.minLength === 'number' ? schema.minLength : undefined
    const maxLength =
      typeof schema.maxLength === 'number' ? schema.maxLength : undefined
    if (minLength !== undefined && value.length < minLength) {
      return { ok: false, error: `String must be at least ${minLength} characters` }
    }
    if (maxLength !== undefined && value.length > maxLength) {
      return { ok: false, error: `String must be at most ${maxLength} characters` }
    }
    const pattern =
      typeof schema.pattern === 'string' ? schema.pattern : undefined
    if (pattern) {
      const re = compileJsonSchemaPattern(pattern)
      if (!re.ok) return re
      if (!re.regex.test(value)) {
        return { ok: false, error: `String does not match pattern: ${pattern}` }
      }
    }
    if (enumValues && !valueInEnum(value, enumValues)) {
      return { ok: false, error: `Expected one of: ${formatEnum(enumValues)}` }
    }
    return { ok: true }
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value))) {
      return { ok: false, error: type === 'integer' ? 'Expected an integer' : 'Expected a number' }
    }
    const minimum =
      typeof schema.minimum === 'number' ? schema.minimum : undefined
    const maximum =
      typeof schema.maximum === 'number' ? schema.maximum : undefined
    if (minimum !== undefined && value < minimum) {
      return { ok: false, error: `Number must be >= ${minimum}` }
    }
    if (maximum !== undefined && value > maximum) {
      return { ok: false, error: `Number must be <= ${maximum}` }
    }
    if (enumValues && !valueInEnum(value, enumValues)) {
      return { ok: false, error: `Expected one of: ${formatEnum(enumValues)}` }
    }
    return { ok: true }
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: 'Expected a boolean' }
    if (enumValues && !valueInEnum(value, enumValues)) {
      return { ok: false, error: `Expected one of: ${formatEnum(enumValues)}` }
    }
    return { ok: true }
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return { ok: false, error: 'Expected an array' }
    const minItems =
      typeof schema.minItems === 'number' ? schema.minItems : undefined
    const maxItems =
      typeof schema.maxItems === 'number' ? schema.maxItems : undefined
    if (minItems !== undefined && value.length < minItems) {
      return { ok: false, error: `Array must have at least ${minItems} items` }
    }
    if (maxItems !== undefined && value.length > maxItems) {
      return { ok: false, error: `Array must have at most ${maxItems} items` }
    }
    const items = schema.items
    if (items && typeof items === 'object' && !Array.isArray(items)) {
      for (let i = 0; i < value.length; i++) {
        const nested = validateAgainstJsonSchema(items as Record<string, unknown>, value[i])
        if (!nested.ok) return { ok: false, error: `[${i}]: ${nested.error}` }
      }
    }
    if (enumValues && !valueInEnum(value, enumValues)) {
      return { ok: false, error: `Expected one of: ${formatEnum(enumValues)}` }
    }
    return { ok: true }
  }
  if (type === 'null') {
    if (value !== null) return { ok: false, error: 'Expected null' }
    return { ok: true }
  }

  // Fail closed on unknown `type` keywords: accepting arbitrarily would let a
  // malformed MCP schema bypass arg validation entirely.
  return { ok: false, error: `Unsupported schema type: ${String(type)}` }
}

function validateObject(
  schema: Record<string, unknown>,
  value: unknown,
  enumValues: unknown[] | undefined
): { ok: true } | { ok: false; error: string } {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Expected an object' }
  }
  const obj = value as Record<string, unknown>
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string')
    : []
  for (const key of required) {
    if (obj[key] === undefined) {
      return { ok: false, error: `Missing required property: ${key}` }
    }
  }
  const properties = schema.properties
  const allowedKeys = new Set<string>()
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, propSchema] of Object.entries(
      properties as Record<string, Record<string, unknown>>
    )) {
      allowedKeys.add(key)
      if (obj[key] === undefined) continue
      const nested = validateAgainstJsonSchema(propSchema, obj[key])
      if (!nested.ok) return { ok: false, error: `${key}: ${nested.error}` }
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(obj)) {
      if (!allowedKeys.has(key)) {
        return { ok: false, error: `Unexpected property: ${key}` }
      }
    }
  }
  if (enumValues && !valueInEnum(value, enumValues)) {
    return { ok: false, error: `Expected one of: ${formatEnum(enumValues)}` }
  }
  return { ok: true }
}

function valueInEnum(value: unknown, enumValues: unknown[]): boolean {
  return enumValues.some((v) => {
    if (v === value) return true
    if (typeof v !== 'object' || typeof value !== 'object') return false
    if (Array.isArray(v) !== Array.isArray(value)) return false
    if (v == null || value == null) return false
    // Stable, conservative deep-equality for object/array enum values.
    return JSON.stringify(v) === JSON.stringify(value)
  })
}

function formatEnum(enumValues: unknown[]): string {
  return enumValues.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')
}

function compileJsonSchemaPattern(
  pattern: string
): { ok: true; regex: RegExp } | { ok: false; error: string } {
  try {
    const regex = compileSchemaPattern(pattern)
    return { ok: true, regex }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Invalid pattern: ${message}` }
  }
}
