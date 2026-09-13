import type { Plugin } from 'vite'
import { createGoCardlessHandler } from './gocardless.ts'
export function goCardlessDevApi(secretId?: string, secretKey?: string, dataApiUrl?: string): Plugin {
  const handler = createGoCardlessHandler(secretId, secretKey, { dataApiUrl })
  return { name: 'next-expense-gocardless-dev-api', configureServer(server) {
    server.middlewares.use('/api/gocardless', handler)
  } }
}
