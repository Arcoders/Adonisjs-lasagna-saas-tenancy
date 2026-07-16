import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import { DEFAULT_MAX_TOOL_ARGS_CHARS, MAX_TOOL_ARGS_CHARS } from '../constants.js'

/**
 * Validate and safely reconstruct a model-generated tool-call argument string
 * (WS-AI-11, Phase 4), with ZERO runtime dependency (no ajv / zod / vine in the
 * package). Model output is untrusted input, so the pipeline is fail-closed:
 *
 * 1. **Bound before parse**: reject an `arguments` string longer than
 *    `maxArgsChars` BEFORE `JSON.parse`, so an adversarial mega-payload never
 *    reaches the parser.
 * 2. **Parse**: a parse error is a rejection (the model emitted malformed JSON).
 * 3. **Prototype-safe reconstruction**: never spread the parsed object. Rebuild a
 *    fresh object copying ONLY the keys the tool's `inputSchema.properties`
 *    declares (the manifest whitelist idiom), which structurally drops
 *    `__proto__` / `constructor` / `prototype` and any undeclared key, so a
 *    pollution payload cannot reach `Object.prototype` or the handler.
 * 4. **Schema check**: either the host's own `parseInput` (e.g. a vine schema, the
 *    app's dependency, never the satellite's) OR the shipped minimal JSON-Schema
 *    subset checker validates the reconstructed value.
 *
 * On any failure it emits `guard.ai_tool_input_invalid` and throws
 * `AIException('tool_input_invalid')`, with a message that names the field or
 * keyword and NEVER echoes the attacker-supplied value (G3).
 */
export function validateToolInput(
  rawArgs: string,
  tool: {
    name: string
    inputSchema: Readonly<Record<string, unknown>>
    parseInput?: (raw: unknown) => unknown
  },
  opts: { maxArgsChars?: number; tenantId?: string } = {}
): Record<string, unknown> {
  const maxArgsChars = clamp(opts.maxArgsChars, DEFAULT_MAX_TOOL_ARGS_CHARS, MAX_TOOL_ARGS_CHARS)
  try {
    if (typeof rawArgs !== 'string') throw new ToolInputError('arguments must be a JSON string')
    // Empty argument text is a common "no-arg" tool call; treat it as `{}`.
    const text = rawArgs.length === 0 ? '{}' : rawArgs
    if (text.length > maxArgsChars) {
      throw new ToolInputError(`arguments exceed the ${maxArgsChars}-character bound`)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ToolInputError('arguments are not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ToolInputError('arguments must be a JSON object')
    }

    // A host `parseInput` validator supersedes the shipped subset checker: hand it
    // the parsed args with dangerous keys recursively stripped (prototype-safe, no
    // schema whitelist so the host sees the real arguments), and sanitize whatever
    // it returns. The subset checker does NOT also run in this branch.
    if (tool.parseInput) {
      const safeParsed = deepSanitize(parsed) as Record<string, unknown>
      let validated: unknown
      try {
        validated = tool.parseInput(safeParsed)
      } catch (error) {
        throw new ToolInputError(
          error instanceof Error && error.message.length > 0
            ? `parseInput rejected the arguments: ${first120(error.message)}`
            : 'parseInput rejected the arguments'
        )
      }
      if (validated === undefined || validated === null) return safeParsed
      if (typeof validated !== 'object' || Array.isArray(validated)) {
        throw new ToolInputError('parseInput must return an object')
      }
      // Deep, not shallow: a host validator could return a nested object, and its
      // whole return is re-injected into the handler, so drop any dangerous key at
      // EVERY level (symmetric with the deepSanitize applied to its input).
      return deepSanitize(validated) as Record<string, unknown>
    }

    // No host validator: prototype-safe whitelist reconstruction (copies only the
    // keys declared in inputSchema.properties, dropping every undeclared and every
    // dangerous key) plus the minimal JSON-Schema-subset check.
    return reconstructAndValidate(tool.inputSchema, parsed, 'arguments') as Record<string, unknown>
  } catch (error) {
    const message =
      error instanceof ToolInputError
        ? error.message
        : 'the tool arguments are invalid'
    emitAiGuardEvent('guard.ai_tool_input_invalid', {
      ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
      metadata: { tool: tool.name.slice(0, 64) },
    })
    throw new AIException('tool_input_invalid', `Refusing the tool call: ${message}`)
  }
}

/** A local, message-only error; the public throw is always an AIException. */
class ToolInputError extends Error {}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'enum',
  'maxLength',
  'minLength',
  'minimum',
  'maximum',
  'items',
])
// Pure annotations that constrain nothing; safe to ignore. `additionalProperties`
// is ignorable because the reconstruction already drops every undeclared key.
const IGNORED_KEYWORDS = new Set([
  'description',
  'title',
  'default',
  'examples',
  '$schema',
  '$id',
  'additionalProperties',
])

/**
 * Recursively reconstruct `value` against `schema`, copying only declared,
 * safe keys and validating the supported JSON-Schema subset. Fail-closed: an
 * unsupported schema keyword (`$ref`, `allOf`, `pattern`, `format`, ...) throws,
 * so a schema this checker cannot fully enforce is never silently passed (the
 * host uses `parseInput` for those). Throws {@link ToolInputError} on any mismatch.
 */
function reconstructAndValidate(schema: unknown, value: unknown, path: string): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new ToolInputError(`${path} has an invalid schema`)
  }
  const node = schema as Record<string, unknown>
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !IGNORED_KEYWORDS.has(key)) {
      throw new ToolInputError(`${path} uses an unsupported schema keyword: ${key.slice(0, 40)}`)
    }
  }

  if (Array.isArray(node.enum)) {
    if (!node.enum.some((option) => option === value)) {
      throw new ToolInputError(`${path} must be one of the allowed values`)
    }
  }

  const type = node.type
  switch (type) {
    case 'object':
      return reconstructObject(node, value, path)
    case 'array':
      return reconstructArray(node, value, path)
    case 'string':
      if (typeof value !== 'string') throw new ToolInputError(`${path} must be a string`)
      if (typeof node.maxLength === 'number' && value.length > node.maxLength) {
        throw new ToolInputError(`${path} exceeds its maxLength`)
      }
      if (typeof node.minLength === 'number' && value.length < node.minLength) {
        throw new ToolInputError(`${path} is shorter than its minLength`)
      }
      return value
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ToolInputError(`${path} must be an integer`)
      }
      checkRange(node, value, path)
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ToolInputError(`${path} must be a number`)
      }
      checkRange(node, value, path)
      return value
    case 'boolean':
      if (typeof value !== 'boolean') throw new ToolInputError(`${path} must be a boolean`)
      return value
    case undefined:
      // No declared type: accept the value once enum (if any) has passed, but if it
      // is an object OR array still rebuild it prototype-safely — dropping any
      // __proto__ / constructor / prototype own key at every level, exactly like the
      // parseInput branch — so an untyped field is never a smuggled pollution gadget.
      if (Array.isArray(value)) return deepSanitize(value)
      if (typeof value === 'object' && value !== null) {
        return reconstructObject(node, value, path)
      }
      return value
    default:
      throw new ToolInputError(`${path} declares an unsupported type`)
  }
}

function reconstructObject(node: Record<string, unknown>, value: unknown, path: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolInputError(`${path} must be an object`)
  }
  const source = value as Record<string, unknown>
  const properties =
    typeof node.properties === 'object' && node.properties !== null
      ? (node.properties as Record<string, unknown>)
      : {}
  const required = Array.isArray(node.required) ? node.required : []

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(properties)) {
    if (DANGEROUS_KEYS.has(key)) continue // never reconstruct a polluting key
    if (!Object.hasOwn(source, key)) continue
    out[key] = reconstructAndValidate(properties[key], source[key], `${path}.${key}`)
  }
  for (const req of required) {
    // `Object.hasOwn`, not `in`: a required property whose name collides with an
    // Object.prototype member (e.g. "toString") must not read as present via the
    // prototype chain when the model actually omitted it.
    if (typeof req === 'string' && !Object.hasOwn(out, req)) {
      throw new ToolInputError(`${path} is missing the required property ${req.slice(0, 40)}`)
    }
  }
  return out
}

function reconstructArray(node: Record<string, unknown>, value: unknown, path: string): unknown {
  if (!Array.isArray(value)) throw new ToolInputError(`${path} must be an array`)
  const itemsSchema = node.items
  // No `items` schema to validate elements against: still rebuild each element
  // prototype-safely rather than shallow-copy the raw parsed objects, so an element
  // object's __proto__ / constructor / prototype own key is dropped at every level
  // (a bare `[...value]` would leave them intact and hand them to the handler).
  if (itemsSchema === undefined) return value.map(deepSanitize)
  return value.map((item, i) => reconstructAndValidate(itemsSchema, item, `${path}[${i}]`))
}

function checkRange(node: Record<string, unknown>, value: number, path: string): void {
  if (typeof node.minimum === 'number' && value < node.minimum) {
    throw new ToolInputError(`${path} is below its minimum`)
  }
  if (typeof node.maximum === 'number' && value > node.maximum) {
    throw new ToolInputError(`${path} is above its maximum`)
  }
}

/**
 * Recursively rebuild `value`, dropping `__proto__` / `constructor` / `prototype`
 * at every level. Used for the `parseInput` branch (which has no schema whitelist),
 * so the host validator never sees a pollution key even in a nested object.
 */
function deepSanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSanitize)
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source)) {
      if (DANGEROUS_KEYS.has(key)) continue
      out[key] = deepSanitize(source[key])
    }
    return out
  }
  return value
}

function first120(message: string): string {
  return message.length > 120 ? message.slice(0, 120) : message
}

function clamp(value: number | undefined, fallback: number, ceiling: number): number {
  const v = value ?? fallback
  if (!Number.isInteger(v) || v < 1) return Math.min(fallback, ceiling)
  return Math.min(v, ceiling)
}
