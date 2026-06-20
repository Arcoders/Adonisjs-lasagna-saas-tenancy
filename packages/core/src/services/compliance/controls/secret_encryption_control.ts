import type { ComplianceControl } from '../types.js'

/**
 * Are stored secrets encryptable at rest? The package derives an AES-256-GCM key
 * from `APP_KEY`; without it, webhook/SSO secrets fall back to plaintext storage.
 * The evidence is deliberate about scope: this covers SECRETS, not application
 * data — so nobody reads "satisfied" as "everything is encrypted at rest".
 */
const secretEncryptionControl: ComplianceControl = {
  id: 'secret-encryption',
  title: 'Stored secrets encrypted at rest (AES-256-GCM)',
  frameworks: ['soc2:CC6.7', 'gdpr:art32', 'iso:A.8.24', 'hipaa:164.312(a)(2)(iv)'],

  detect() {
    const hasKey = typeof process.env.APP_KEY === 'string' && process.env.APP_KEY.length > 0

    if (hasKey) {
      return {
        status: 'satisfied',
        evidence:
          'APP_KEY is set; webhook signing secrets and SSO client secrets are stored ' +
          'AES-256-GCM encrypted (enc_v1:). This covers SECRETS only — not arbitrary ' +
          'application/tenant data, and not pg_dump archives at rest.',
        hostResponsibility:
          'Encrypt application data yourself (volume/disk encryption, TDE, or pgcrypto) ' +
          'and the backup storage at rest. Rotate APP_KEY via tenant:secrets:reencrypt.',
      }
    }

    return {
      status: 'action-needed',
      evidence: 'APP_KEY is not set; stored secrets cannot be encrypted.',
      hostResponsibility: 'Provision and protect APP_KEY through a secrets manager.',
      remediation: 'Set APP_KEY (32+ random bytes) in the environment / secrets manager.',
    }
  },
}

export default secretEncryptionControl
