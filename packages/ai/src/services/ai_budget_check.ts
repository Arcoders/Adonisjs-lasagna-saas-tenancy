import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { MultitenancyConfigWithAi } from '../define_config.js'
import { AI_TOKENS_QUOTA } from '../constants.js'

/** A budget posture: an issue naming the metering risk, or null when healthy. */
export interface AiBudgetPosture {
  code: string
  severity: 'info' | 'warn'
  message: string
}

function finiteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Assess whether the `aiTokens` quota is budgeted, from the STATIC config alone.
 * The kernel's reserve rail enforces iff the resolved per-tenant limit OR the
 * operator ceiling is finite (the inert-handle path in quota_service): with
 * neither, `reserve` returns an inert handle and the AI endpoint runs unmetered.
 *
 * This reads `plans.operatorCeiling` and the static `plans.definitions`. A host
 * that budgets `aiTokens` through a dynamic `getPlan` / `tenant_plans` store is
 * invisible to a static read, so that case is an `info`, never a `warn` (a hard
 * mount block would false-positive it). Returns null when the posture is healthy.
 */
export function aiTokensBudgetPosture(
  config: MultitenancyConfigWithAi | undefined
): AiBudgetPosture | null {
  if (!config?.ai) return null // no AI configured: nothing to meter

  const plans = config.plans
  if (finiteNumber(plans?.operatorCeiling?.[AI_TOKENS_QUOTA])) {
    return null // a fleet-wide operator ceiling meters every tenant: healthy
  }

  const definitions = plans?.definitions ?? {}
  const anyPlanBudgets = Object.values(definitions).some((definition) =>
    finiteNumber((definition as { limits?: Record<string, number> })?.limits?.[AI_TOKENS_QUOTA])
  )
  if (anyPlanBudgets) {
    return {
      code: 'ai_budget_no_operator_ceiling',
      severity: 'info',
      message:
        `config.plans budgets ${AI_TOKENS_QUOTA} per plan but sets no plans.operatorCeiling.${AI_TOKENS_QUOTA}; ` +
        `a plan without a ${AI_TOKENS_QUOTA} limit runs unmetered, and no fleet-wide ceiling guards denial of wallet`,
    }
  }

  if (config.ai.acknowledgeUnbudgetedAiTokens === true) {
    return {
      code: 'ai_budget_unbudgeted_acknowledged',
      severity: 'info',
      message: `acknowledged: ${AI_TOKENS_QUOTA} has no plan budget or operator ceiling, so the AI endpoint runs unmetered`,
    }
  }

  const dynamic = typeof plans?.getPlan === 'function' || plans?.storage === 'tenant_plans'
  if (dynamic) {
    return {
      code: 'ai_budget_dynamic_plans',
      severity: 'info',
      message:
        `no static ${AI_TOKENS_QUOTA} plan budget or operator ceiling was found; if you budget it through a dynamic ` +
        `getPlan or tenant_plans this is expected, otherwise the AI endpoint runs unmetered`,
    }
  }

  return {
    code: 'ai_budget_unbudgeted',
    severity: 'warn',
    message:
      `${AI_TOKENS_QUOTA} has no per-plan budget and no plans.operatorCeiling.${AI_TOKENS_QUOTA}: the AI cost ` +
      `governor is inert and the endpoint runs unmetered (denial-of-wallet exposure). Budget it in config.plans ` +
      `or set config.ai.acknowledgeUnbudgetedAiTokens: true`,
  }
}

/**
 * The `ai_budget` doctor check: surfaces the `aiTokens` cost-metering posture so
 * an unbudgeted (inert reserve) AI endpoint never runs silently unmetered. This
 * is the run-time-aware companion to the boot warning, both reading
 * {@link aiTokensBudgetPosture}. Config is read through the injected getter at
 * RUN time, so the check reports the live posture and unit-tests without an app.
 */
export function aiBudgetCheck(getConfig: () => MultitenancyConfigWithAi | undefined): DoctorCheck {
  return {
    name: 'ai_budget',
    description:
      'Reports whether the AI aiTokens quota is budgeted (a per-plan limit or an operator ceiling); ' +
      'an unbudgeted quota leaves the AI endpoint unmetered, a denial-of-wallet exposure.',
    run(): DiagnosisIssue[] {
      const posture = aiTokensBudgetPosture(getConfig())
      return posture
        ? [{ code: posture.code, severity: posture.severity, message: posture.message }]
        : []
    },
  }
}
