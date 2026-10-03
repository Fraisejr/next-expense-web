import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { neonAuthZodImport } from './neon-auth-zod-import.mjs'

const dir = resolve('node_modules/@neondatabase/auth/dist')
const file = readdirSync(dir).find(name => /^adapter-core-.*\.mjs$/.test(name))
assert.ok(file, 'Expected reviewed SDK adapter')
const id = resolve(dir, file)
const code = readFileSync(id, 'utf8')
const plugin = neonAuthZodImport()
const transformed = plugin.transform(code, id).code
assert.ok(transformed.includes('import { object, string, number } from "zod";'))
assert.equal(transformed.replace('import { object, string, number } from "zod"; const z = { object, string, number };', 'import z from "zod";'), code)
assert.equal(plugin.transform(code, '/app/adapter-core-other.mjs'), undefined)
assert.throws(() => plugin.transform(code + '\n// SDK change', id), /adapter changed/)
assert.ok(plugin.transform(code.replaceAll('\n', '\r\n'), id))

// Resolve the SDK's nested Zod, not another application's Zod version.
const sdkRequire = createRequire(pathToFileURL(id))
const zod = await import(pathToFileURL(sdkRequire.resolve('zod')).href)
const expression = code.match(/const anonymousTokenResponseSchema = ([\s\S]*?);/)[1]
const original = runInNewContext(expression, { z: zod.default })
const optimized = runInNewContext(expression, { z: { object: zod.object, string: zod.string, number: zod.number } })
const inputs = [
  { token: 'jwt', expires_at: 123 }, { token: '', expires_at: 0, extra: 'ignored' },
  {}, null, [], 'invalid', { token: 123, expires_at: '123' },
  { token: 'jwt' }, { expires_at: 123 }, { token: 'jwt', expires_at: NaN },
  { token: 'jwt', expires_at: Infinity },
]
for (const input of inputs) {
  const serialize = result => JSON.parse(JSON.stringify(result.success ? { success: true, data: result.data } : { success: false, issues: result.error.issues }))
  assert.deepEqual(serialize(optimized.safeParse(input)), serialize(original.safeParse(input)))
}
console.log(`Neon Auth import guard and ${inputs.length} validation parity cases passed`)
