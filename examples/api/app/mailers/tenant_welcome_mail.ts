import { BaseMail } from '@adonisjs/mail'

interface TenantInfo {
  id: string
  name: string
  email: string
}

interface BrandingInfo {
  fromName: string
  fromEmail: string
  primaryColor: string
  supportUrl: string | null
  logoUrl: string | null
}

/**
 * Welcome email rendered with the tenant's branding row. Fired from the
 * `TenantActivated` listener in `start/routes.ts`. Each tenant's email
 * carries their own from-address, primary colour, and support URL — the
 * cross-tenant isolation test in `tests/e2e/mail.spec.ts` verifies that
 * one tenant's branding never leaks into another's email.
 *
 * The activation link is deterministic from the tenant id so the test can
 * assert its presence without parsing tokens.
 */
export default class TenantWelcomeMail extends BaseMail {
  constructor(public tenant: TenantInfo, public branding: BrandingInfo) {
    super()
  }

  prepare() {
    this.message.from(this.branding.fromEmail, this.branding.fromName)
    this.message.to(this.tenant.email)
    this.message.subject(`Welcome to ${this.branding.fromName}, ${this.tenant.name}!`)

    const activationUrl = `https://${this.tenant.id}.example.test/activate?token=${this.tenant.id}`

    const html = `
      <!DOCTYPE html>
      <html>
        <body style="margin:0;padding:0;font-family:Arial,sans-serif">
          <div style="background:${this.branding.primaryColor};padding:24px;color:#fff">
            ${this.branding.logoUrl ? `<img src="${this.branding.logoUrl}" alt="logo" style="max-height:48px"/>` : ''}
            <h1 style="margin:0">Welcome, ${escapeHtml(this.tenant.name)}!</h1>
          </div>
          <div style="padding:24px">
            <p>Your tenant <strong>${escapeHtml(this.tenant.name)}</strong> is now active.</p>
            <p>
              <a href="${activationUrl}" style="background:${this.branding.primaryColor};color:#fff;padding:12px 18px;border-radius:4px;text-decoration:none">
                Get started
              </a>
            </p>
            <p style="font-size:12px;color:#666">
              Activation link: <a href="${activationUrl}">${activationUrl}</a>
            </p>
            ${
              this.branding.supportUrl
                ? `<p style="font-size:12px;color:#666">Need help? <a href="${this.branding.supportUrl}">Visit support</a></p>`
                : ''
            }
          </div>
          <div style="padding:12px;background:#f5f5f5;font-size:11px;color:#999;text-align:center">
            Sent by ${escapeHtml(this.branding.fromName)} · tenant ${this.tenant.id}
          </div>
        </body>
      </html>
    `.trim()

    this.message.html(html)
    this.message.text(
      `Welcome, ${this.tenant.name}!\n\nActivate at: ${activationUrl}\n\nSent by ${this.branding.fromName}`
    )
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
