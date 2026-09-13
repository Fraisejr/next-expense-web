import { defineConfig, loadEnv } from 'vite'
import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { goCardlessDevApi } from './server/gocardless-dev.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    // Local archive imports contain personal financial data. Only these public
    // authentication assets belong in a production bundle.
    build: { copyPublicDir: false },
    plugins: [react(), goCardlessDevApi(env.GOCARDLESS_SECRET_ID, env.GOCARDLESS_SECRET_KEY, env.VITE_NEON_DATA_API_URL), {
      name: 'public-auth-assets',
      generateBundle() {
        for (const name of ['callback.html', 'return.mjs', 'style.css']) {
          this.emitFile({ type: 'asset', fileName: `auth/ios/${name}`, source: readFileSync(`public/auth/ios/${name}`) })
        }
      },
    }],
  }
})
