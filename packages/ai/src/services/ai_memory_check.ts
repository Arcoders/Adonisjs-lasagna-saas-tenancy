import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../define_config.js'

/** A memory posture: an issue naming the caveat, or null when nothing to report. */
export interface AiMemoryPosture {
  code: string
  severity: 'info' | 'warn'
  message: string
}

/**
 * Assess the conversation-memory (WS-AI-4, I2) posture from the static config.
 *
 * Memory binds every session to the resolved principal (`config.ai.resolvePrincipal`,
 * default the `@adonisjs/auth` user id): that binding IS the per-user isolation
 * (G6), so a request with no resolvable principal is deliberately stateless
 * (memory inert). When memory is enabled but no explicit `resolvePrincipal` is
 * wired, surface that it falls back to the auth user id and is inert without one —
 * an `info`, because the default works for most hosts and a static read cannot see
 * whether auth is present at runtime. Returns null when memory is off, or on and
 * explicitly bound.
 */
export function aiMemoryPosture(ai: AiConfig | undefined): AiMemoryPosture | null {
  if (!ai?.memory) return null // memory not configured: nothing to report

  if (typeof ai.resolvePrincipal !== 'function') {
    return {
      code: 'ai_memory_default_principal',
      severity: 'info',
      message:
        'conversation memory is enabled but no config.ai.resolvePrincipal is set: sessions bind to the ' +
        '@adonisjs/auth user id by default, and any request without a resolvable principal is stateless ' +
        '(memory inert). Set resolvePrincipal to a stable, immutable per-user id to make the binding explicit.',
    }
  }
  return null
}

/**
 * The `ai_memory` doctor check: surfaces the conversation-memory principal
 * posture so an enabled-but-inert memory (no resolvable principal) never runs
 * silently stateless. Config is read through the injected getter at RUN time, so
 * the check reports the live posture and unit-tests without an app.
 */
export function aiMemoryCheck(getAiConfig: () => AiConfig | undefined): DoctorCheck {
  return {
    name: 'ai_memory',
    description:
      'Reports the conversation-memory posture (WS-AI-4): whether it is enabled and how its per-user ' +
      'session isolation binds to the resolved principal, so an inert (no-principal) memory is visible.',
    run(): DiagnosisIssue[] {
      const posture = aiMemoryPosture(getAiConfig())
      return posture
        ? [{ code: posture.code, severity: posture.severity, message: posture.message }]
        : []
    },
  }
}
