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

// Migration helper: the DB-level ciphertext CHECK that rejects a raw plaintext
// write to a host's encrypted field columns, catching the raw-SQL, query-builder,
// and `*Quietly` write paths the model hooks cannot.
export {
  CIPHERTEXT_PREFIXES,
  encryptedColumnCheckName,
  encryptedColumnCheckPredicate,
  encryptedColumnCheckSql,
} from './schema/encrypted_column.js'
export type { EncryptedColumnCheckOptions } from './schema/encrypted_column.js'

// The frozen key-hierarchy types (vault and governance reference these).
export type { CategoryKey, KeyProvider, SubjectId, WrappedDek } from './types/key_provider.js'

// Blind-index (deterministic search HMAC) options.
export type { BlindIndexOptions } from './internal/blind_index.js'

// Framed enc_v2 stream envelope: the composition vault consumes to seal large
// blobs before upload. One AEAD (core's), applied per frame with reorder and
// truncation binding. NOT a new cipher.
export {
  sealFramedV2,
  openFramedV2,
  sealFramedV2Stream,
  openFramedV2Stream,
} from './internal/framed_stream.js'
export {
  DEFAULT_FRAME_SIZE,
  FRAMED_STREAM_PREFIX,
  type FramedSealOptions,
} from './types/framed_envelope.js'

// Transparent field-encryption decorators.
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

// Shred seams: governance's erasability gate and the fail-closed WORM ledger.
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
// The SSRF-pinned base for HTTP-backed KeyProviders (KMS or Vault), plus a Vault
// reference. A host binds one of these (or a custom subclass) and names it in
// `config.crypto.keyProvider`. Every outbound is routed through core safeFetch.
export { default as HttpKeyProvider } from './services/http_key_provider.js'
export type { HttpKeyProviderOptions, HttpKeyRequest } from './services/http_key_provider.js'
export { default as VaultKeyProvider } from './services/vault_key_provider.js'
export type { VaultKeyProviderOptions } from './services/vault_key_provider.js'
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
