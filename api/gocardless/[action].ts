import { createGoCardlessHandler } from '../../server/gocardless.ts'
export default createGoCardlessHandler(process.env.GOCARDLESS_SECRET_ID, process.env.GOCARDLESS_SECRET_KEY, {
  dataApiUrl: process.env.VITE_NEON_DATA_API_URL,
  appUrl: process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'https://unconfigured.invalid'),
})
