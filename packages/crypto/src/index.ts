// Config surface (the wiring `check-satellite-config-wiring.mjs` enforces).
export { defineCryptoConfig } from './define_config.js'
export type {
  CryptoConfig,
  CryptoFieldConfig,
  MultitenancyConfigWithCrypto,
} from './define_config.js'
export { assertCryptoConfig } from './validate_config.js'

// Contract + constants.
export { CRYPTO_CONTRACT_VERSION } from './sdk/contract_version.js'
export { CRYPTO_WRAPPED_DEKS_TABLE, DEFAULT_KEY_PROVIDER, DEK_BYTES } from './constants.js'

// The frozen key-hierarchy types (crypto §6.2; vault + governance reference these).
export type { CategoryKey, KeyProvider, SubjectId, WrappedDek } from './types/key_provider.js'

// Services.
export { default as CryptoService } from './services/crypto_service.js'
export type { CryptoServiceDeps } from './services/crypto_service.js'
export { default as KeyProviderRegistry } from './services/key_provider_registry.js'
export { default as EnvKeyProvider } from './services/env_key_provider.js'
export { default as PgWrappedDekStore } from './services/pg_wrapped_dek_store.js'
export type {
  CryptoDb,
  CryptoQueryClient,
  CryptoStoreDriver,
  PgWrappedDekStoreDeps,
} from './services/pg_wrapped_dek_store.js'
export type {
  NewWrappedDekRow,
  WrappedDekRow,
  WrappedDekStore,
} from './services/wrapped_dek_store.js'

// Exceptions.
export { default as CryptoException, CRYPTO_ERROR_CODES } from './exceptions/crypto_exception.js'
export type { CryptoErrorCode } from './exceptions/crypto_exception.js'
