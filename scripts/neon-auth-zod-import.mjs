import { createHash } from 'node:crypto'

// Reviewed @neondatabase/auth 0.5.0-beta adapter. Only the import changes:
// the same classic Zod constructors and validation remain in use.
const reviewedHash = 'c244d3ae18862c419f77a6b73895279ea7057c3393107bb11410af47ad94d8b8'
export function neonAuthZodImport() {
  return {
    name: 'neon-auth-named-zod-import',
    apply: 'build',
    enforce: 'pre',
    transform(code, id) {
      if (!/\/@neondatabase\/auth\/dist\/adapter-core-[^/]+\.mjs$/.test(id.replaceAll('\\', '/'))) return
      const hash = createHash('sha256').update(code.replaceAll('\r\n', '\n')).digest('hex')
      if (hash !== reviewedHash) {
        throw new Error('Neon Auth adapter changed. Review scripts/neon-auth-zod-import.mjs before building; remove the plugin to use the SDK unchanged.')
      }
      return {
        code: code.replace('import z from "zod";', 'import { object, string, number } from "zod"; const z = { object, string, number };'),
        map: null,
      }
    },
  }
}
