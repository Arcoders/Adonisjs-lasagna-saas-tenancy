export { default as TenantResolverRegistry } from './registry.js'
export type { TenantResolver, TenantResolveResult, ResolverTrust } from './resolver.js'
export { ResolverHit, RESOLVER_CONTRACT_VERSION, SyncTenantResolver } from './resolver.js'
export {
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
  builtInResolvers,
} from './builtins.js'
