export { default as TenantResolverRegistry } from './registry.js'
export type { TenantResolver, TenantResolveResult } from './resolver.js'
export { ResolverHit } from './resolver.js'
export {
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
  builtInResolvers,
} from './builtins.js'
