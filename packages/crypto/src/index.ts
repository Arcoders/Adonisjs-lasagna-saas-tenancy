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

// Blind-index (deterministic search HMAC) options (crypto §6.5, I5).
export type { BlindIndexOptions } from './internal/blind_index.js'

// Transparent field-encryption decorators (crypto §6.4 Option A).
export { encrypted, searchable } from './models/encrypted_columns.js'
export type {
  EncryptedColumnMeta,
  EncryptedFieldsRepo,
  EncryptedOptions,
  ModelEncryptionMeta,
  SearchableColumnMeta,
  SearchableOptions,
} from './models/encrypted_columns.js'
export { withEncryptedFields } from './models/with_encrypted_fields.js'

// Shred seams (crypto §6.6): governance's erasability gate + the fail-closed WORM ledger.
export type { ErasabilityResolver, ErasabilityVerdict } from './types/erasability.js'
export type { PendingShredEntry, ShredLedger, ShredLedgerEntry } from './types/shred_ledger.js'
export type { SubjectShreddedEvent } from './events/subject_shredded.js'

// Services.
export { default as CryptoService } from './services/crypto_service.js'
export type { CryptoServiceDeps, ShredOptions, ShredResult } from './services/crypto_service.js'
export type { CryptoOperationLock } from './types/operation_lock.js'
export { default as RekekService } from './services/rekek_service.js'
export type {
  RekekFailure,
  RekekOptions,
  RekekServiceDeps,
  RekekTenantSummary,
} from './services/rekek_service.js'
export { default as EncryptedRepository } from './services/encrypted_repository.js'
export type { EncryptedRepositoryDeps } from './services/encrypted_repository.js'
export { default as KeyProviderRegistry } from './services/key_provider_registry.js'
export { default as EnvKeyProvider } from './services/env_key_provider.js'
export { default as WormShredLedger } from './services/worm_shred_ledger.js'
export { default as PgWrappedDekStore } from './services/pg_wrapped_dek_store.js'
export type {
  CryptoDb,
  CryptoQueryClient,
  CryptoStoreDriver,
  PgWrappedDekStoreDeps,
} from './services/pg_wrapped_dek_store.js'
export type {
  ListLiveOptions,
  NewWrappedDekRow,
  WrappedDekRow,
  WrappedDekStore,
} from './services/wrapped_dek_store.js'

// Exceptions.
export { default as CryptoException, CRYPTO_ERROR_CODES } from './exceptions/crypto_exception.js'
export type { CryptoErrorCode } from './exceptions/crypto_exception.js'
