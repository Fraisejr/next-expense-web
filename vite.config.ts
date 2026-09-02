import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { goCardlessDevApi } from './server/gocardless.ts'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react(), goCardlessDevApi(env.GOCARDLESS_SECRET_ID, env.GOCARDLESS_SECRET_KEY)],
  }
})
