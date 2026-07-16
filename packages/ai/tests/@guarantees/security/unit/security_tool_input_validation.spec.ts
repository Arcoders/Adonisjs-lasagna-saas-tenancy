import { test } from '@japa/runner'
import { validateToolInput } from '../../../../src/gateway/tool_input.js'
import AIException from '../../../../src/exceptions/ai_exception.js'

function tool(inputSchema: Record<string, unknown>, parseInput?: (raw: unknown) => unknown) {
  return { name: 'read', inputSchema, ...(parseInput ? { parseInput } : {}) }
}

const objSchema = (properties: Record<string, unknown>, required?: string[]) =>
  tool({ type: 'object', properties, ...(required ? { required } : {}) })

test.group('security — tool input validation (prototype-safe, dependency-free)', () => {
  test('__proto__ and constructor in args never pollute Object.prototype', ({ assert }) => {
    const args = validateToolInput(
      '{"safe":"ok","__proto__":{"polluted":true},"constructor":{"x":1}}',
      objSchema({ safe: { type: 'string' } }),
      {}
    )
    assert.deepEqual(args, { safe: 'ok' })
    assert.isUndefined(({} as Record<string, unknown>).polluted)
  })

  test('a nested __proto__ is dropped by the whitelist reconstruction', ({ assert }) => {
    const args = validateToolInput(
      '{"nested":{"keep":1,"__proto__":{"bad":1}}}',
      objSchema({ nested: { type: 'object', properties: { keep: { type: 'number' } } } }),
      {}
    )
    assert.deepEqual(args, { nested: { keep: 1 } })
    assert.isUndefined(({} as Record<string, unknown>).bad)
  })

  test('a __proto__ inside an array element is stripped (items-less array)', ({ assert }) => {
    // An array field with no `items` schema must still drop dangerous keys in its
    // element objects, not shallow-copy the raw parsed objects to the handler.
    const args = validateToolInput(
      '{"tags":[{"id":1,"__proto__":{"bad":1}}]}',
      objSchema({ tags: { type: 'array' } }),
      {}
    )
    const first = (args.tags as Record<string, unknown>[])[0]!
    assert.isFalse(Object.hasOwn(first, '__proto__'))
    assert.deepEqual(first, { id: 1 })
    assert.isUndefined(({} as Record<string, unknown>).bad)
  })

  test('a __proto__ inside an untyped field is stripped at every level', ({ assert }) => {
    // A property with no declared `type` holding an array of objects.
    const args = validateToolInput(
      '{"data":[{"__proto__":{"bad":1}}]}',
      objSchema({ data: {} }),
      {}
    )
    const first = (args.data as Record<string, unknown>[])[0]!
    assert.isFalse(Object.hasOwn(first, '__proto__'))
    assert.deepEqual(first, {})
    assert.isUndefined(({} as Record<string, unknown>).bad)
  })

  test('a required property named like an Object.prototype member is enforced via hasOwn', ({
    assert,
  }) => {
    // `'toString' in out` would be true via the prototype chain; the model omitted
    // it, so a hasOwn check must still reject the missing required property.
    assert.throws(
      () => validateToolInput('{}', objSchema({ toString: { type: 'string' } }, ['toString']), {}),
      /required property/
    )
  })

  test('a host parseInput return is sanitized DEEPLY, not just at the top level', ({ assert }) => {
    const args = validateToolInput(
      '{"a":1}',
      tool({}, () => ({ wrapper: JSON.parse('{"keep":1,"__proto__":{"bad":1}}') })),
      {}
    )
    const wrapper = args.wrapper as Record<string, unknown>
    assert.isFalse(Object.hasOwn(wrapper, '__proto__'))
    assert.deepEqual(wrapper, { keep: 1 })
    assert.isUndefined(({} as Record<string, unknown>).bad)
  })

  test('an oversized argument string is rejected BEFORE parse', ({ assert }) => {
    const huge = `{"x":"${'a'.repeat(9000)}"}`
    assert.throws(
      () => validateToolInput(huge, objSchema({ x: { type: 'string' } }), { maxArgsChars: 100 }),
      /Refusing the tool call/
    )
  })

  test('empty argument text is treated as an empty object', ({ assert }) => {
    assert.deepEqual(validateToolInput('', objSchema({}), {}), {})
  })

  test('non-JSON, non-object and undeclared-only inputs are handled', ({ assert }) => {
    assert.throws(() => validateToolInput('{bad', objSchema({}), {}), /not valid JSON/)
    assert.throws(() => validateToolInput('[]', objSchema({}), {}), /must be a JSON object/)
    // undeclared keys are stripped, not an error
    assert.deepEqual(validateToolInput('{"ghost":1}', objSchema({}), {}), {})
  })

  test('schema-subset mismatches are rejected (type, enum, required, maxLength, range)', ({
    assert,
  }) => {
    assert.throws(
      () => validateToolInput('{"n":"x"}', objSchema({ n: { type: 'number' } }), {}),
      /must be a number/
    )
    assert.throws(
      () =>
        validateToolInput('{"s":"z"}', objSchema({ s: { type: 'string', enum: ['a', 'b'] } }), {}),
      /allowed values/
    )
    assert.throws(
      () => validateToolInput('{}', objSchema({ n: { type: 'number' } }, ['n']), {}),
      /required property/
    )
    assert.throws(
      () =>
        validateToolInput(
          '{"s":"toolong"}',
          objSchema({ s: { type: 'string', maxLength: 3 } }),
          {}
        ),
      /maxLength/
    )
    assert.throws(
      () => validateToolInput('{"n":100}', objSchema({ n: { type: 'integer', maximum: 10 } }), {}),
      /above its maximum/
    )
  })

  test('an unsupported schema keyword fails closed (use parseInput for those)', ({ assert }) => {
    assert.throws(
      () => validateToolInput('{"s":"a"}', objSchema({ s: { type: 'string', pattern: '^a' } }), {}),
      /unsupported schema keyword/
    )
  })

  test('a valid input passes and reconstructs only declared keys', ({ assert }) => {
    const args = validateToolInput(
      '{"status":"active","limit":5,"ghost":"x"}',
      objSchema({
        status: { type: 'string', enum: ['active', 'closed'] },
        limit: { type: 'integer' },
      }),
      {}
    )
    assert.deepEqual(args, { status: 'active', limit: 5 })
  })

  test('a host parseInput supersedes the subset checker and stays prototype-safe', ({ assert }) => {
    const args = validateToolInput(
      '{"a":1,"__proto__":{"bad":1}}',
      tool({}, (raw) => ({ ...(raw as Record<string, unknown>), extra: true })),
      {}
    )
    assert.deepEqual(args, { a: 1, extra: true })
    assert.isUndefined(({} as Record<string, unknown>).bad)
  })

  test('a rejecting parseInput becomes a tool_input_invalid, not a raw throw', ({ assert }) => {
    let err: unknown
    try {
      validateToolInput(
        '{"a":1}',
        tool({}, () => {
          throw new Error('vine says no')
        }),
        {}
      )
    } catch (e) {
      err = e
    }
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'tool_input_invalid')
  })
})
