import { test } from '@japa/runner'
import type {
  TenantAccessAuthorizer,
  TenantAnonymizer,
  TenantResolverStrategy,
  ResolverConfig,
  ResolverCacheConfig,
  RequestDataResolverConfig,
  BackupRetentionTier,
  BackupRetentionConfig,
  PlanDefinition,
  PlansConfig,
  BillingDriverChoice,
  BillingConfig,
  ReadReplicaStrategy,
  ReadReplicaHost,
  ReadReplicasConfig,
  IsolationDriverChoice,
  IsolationConfig,
  RoutingConfig,
  FailurePolicy,
  ResilienceConfig,
  MultitenancyConfig,
} from '../../src/types/config.js'

/**
 * The config types were split into `types/config/*.ts` re-exported from the
 * `config.ts` barrel. Every consumer — the package root, the `./types` subpath,
 * and the satellites — imports them from that single barrel, so dropping a
 * re-export during a future split would dangle imports across the workspace.
 * This guard fails to COMPILE the moment that happens (the type-only import
 * above stops resolving), enforced by `npm run typecheck`, long before a
 * downstream consumer breaks. The runtime body is trivial; the contract is the
 * import + the type map below.
 */
type ConfigBarrel = {
  TenantAccessAuthorizer: TenantAccessAuthorizer
  TenantAnonymizer: TenantAnonymizer
  TenantResolverStrategy: TenantResolverStrategy
  ResolverConfig: ResolverConfig
  ResolverCacheConfig: ResolverCacheConfig
  RequestDataResolverConfig: RequestDataResolverConfig
  BackupRetentionTier: BackupRetentionTier
  BackupRetentionConfig: BackupRetentionConfig
  PlanDefinition: PlanDefinition
  PlansConfig: PlansConfig
  BillingDriverChoice: BillingDriverChoice
  BillingConfig: BillingConfig
  ReadReplicaStrategy: ReadReplicaStrategy
  ReadReplicaHost: ReadReplicaHost
  ReadReplicasConfig: ReadReplicasConfig
  IsolationDriverChoice: IsolationDriverChoice
  IsolationConfig: IsolationConfig
  RoutingConfig: RoutingConfig
  FailurePolicy: FailurePolicy
  ResilienceConfig: ResilienceConfig
  MultitenancyConfig: MultitenancyConfig
}

test.group('config barrel exhaustiveness', () => {
  test('every historical config type still re-exports from the config.ts barrel', ({ assert }) => {
    // The real contract is the compile-time type map above; this asserts the
    // module evaluated and lists the guarded surface for a human reader.
    const guarded: Array<keyof ConfigBarrel> = [
      'TenantAccessAuthorizer',
      'TenantAnonymizer',
      'TenantResolverStrategy',
      'ResolverConfig',
      'ResolverCacheConfig',
      'RequestDataResolverConfig',
      'BackupRetentionTier',
      'BackupRetentionConfig',
      'PlanDefinition',
      'PlansConfig',
      'BillingDriverChoice',
      'BillingConfig',
      'ReadReplicaStrategy',
      'ReadReplicaHost',
      'ReadReplicasConfig',
      'IsolationDriverChoice',
      'IsolationConfig',
      'RoutingConfig',
      'FailurePolicy',
      'ResilienceConfig',
      'MultitenancyConfig',
    ]
    assert.lengthOf(guarded, 21)
  })
})
