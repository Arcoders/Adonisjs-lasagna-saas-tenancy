import env from '#start/env'
import { defineConfig, transports } from '@adonisjs/mail'

/**
 * Mail config. Points at MailCatcher in dev/test (`MAILCATCHER_HOST:1025`);
 * captured messages are at http://localhost:1080. Swap the SMTP transport for a
 * real provider (Postmark/SES/Resend) in production. Powers the tenant-welcome
 * mail fired when a company is activated.
 */
export default defineConfig({
  default: 'smtp',
  from: {
    address: env.get('MAIL_FROM_ADDRESS', 'noreply@karimoto.test'),
    name: env.get('MAIL_FROM_NAME', 'Karimoto'),
  },
  mailers: {
    smtp: transports.smtp({
      host: env.get('MAILCATCHER_HOST', '127.0.0.1'),
      port: env.get('MAILCATCHER_PORT', 1025),
      secure: false,
    }),
  },
})
