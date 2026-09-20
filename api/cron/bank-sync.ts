import { createAutomaticBankSyncHandler } from '../../server/bank-sync-cron.ts'

export default createAutomaticBankSyncHandler({
  authUrl: process.env.VITE_NEON_AUTH_URL,
  dataApiUrl: process.env.VITE_NEON_DATA_API_URL,
  email: process.env.BANK_SYNC_AUTH_EMAIL,
  password: process.env.BANK_SYNC_AUTH_PASSWORD,
  cronSecret: process.env.CRON_SECRET,
  appUrl: process.env.APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined),
  gocardlessSecretId: process.env.GOCARDLESS_SECRET_ID,
  gocardlessSecretKey: process.env.GOCARDLESS_SECRET_KEY,
})
