import env from '#start/env'
import { defineConfig, transports } from '@adonisjs/mail'

/**
 * Mail config. Points at MailCatcher in dev/test (`MAILCATCHER_HOST:1025`).
 * In production you'd swap the SMTP transport for a real provider (Postmark,
 * SES, Mailgun, Resend, etc.).
 *
 * Captured messages are visible at http://localhost:1080 and at the JSON API
 * `http://localhost:1080/messages` — the e2e mail.spec.ts uses the latter.
 */
export default defineConfig({
  default: 'smtp',
  from: {
    address: env.get('MAIL_FROM_ADDRESS', 'demo@example.test'),
    name: env.get('MAIL_FROM_NAME', 'Demo Multitenancy'),
  },
  mailers: {
    smtp: transports.smtp({
      host: env.get('MAILCATCHER_HOST', '127.0.0.1'),
      port: env.get('MAILCATCHER_PORT', 1025),
      secure: false,
    }),
  },
})
