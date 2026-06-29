import { spawn } from 'node:child_process'
import { mkdir, unlink, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/internal'
import { backupConfig, destructiveLockFailClosed } from '../config.js'
import { withTenantOperationLock } from './tenant_operation_lock.js'
import { assertRegularFile } from './fs_guards.js'
import type { BackupMetadata, TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

// `BackupMetadata` is defined in the core (the lifecycle hook context + the
// `TenantBackedUp` event carry it). Re-exported here so this package's other
// modules can keep importing it from `./backup_service.js`.
export type { BackupMetadata }

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

async function logInfo(payload: Record<string, unknown>, msg: string): Promise<void> {
  const log = await lazyLogger()
  log?.info(payload, msg)
}

async function logWarn(payload: Record<string, unknown>, msg: string): Promise<void> {
  const log = await lazyLogger()
  log?.warn(payload, msg)
}

// Accept the filenames our own producer writes:
//   tenant_<uuid>_<ISO timestamp with `:` / `.` rewritten to `-`>.dump
// e.g. tenant_abcd_2026-05-02T16-16-36-264Z.dump
// Path traversal (`/`, `\`, `..`) is still rejected by virtue of not being in
// the character class.
const FILE_PATTERN = /^[A-Za-z0-9._-]+\.dump$/

/**
 * Per-tenant logical backup service. It shells out to `pg_dump` to write a
 * tenant's schema and data to a timestamped `.dump` archive under the configured
 * storage path (or object storage), records and lists archive metadata in Redis,
 * restores a tenant from a named dump, and deletes archives. Every operation is
 * guarded by a tenant operation lock and strict filename validation so one
 * tenant can never read or overwrite another's archives.
 */
export default class BackupService {
  private getBackupDir(tenantId: string): string {
    return join(backupConfig().storagePath, tenantId)
  }

  private metaKey(tenantId: string): string {
    return `backup:meta:${tenantId}`
  }

  private sidecarPath(tenantId: string): string {
    return join(this.getBackupDir(tenantId), 'backup.json')
  }

  private buildConnectionArgs(): string[] {
    const { host, port, user, database } = backupConfig().pgConnection
    return ['-h', host, '-p', String(port), '-U', user, '-d', database]
  }

  async backup(tenant: TenantModelContract): Promise<BackupMetadata> {
    // Serialise against any other backup/restore/clone/import of this tenant.
    return withTenantOperationLock(tenant.id, 'backup', () => this.#backupLocked(tenant))
  }

  async #backupLocked(tenant: TenantModelContract): Promise<BackupMetadata> {
    const schema = tenant.schemaName
    // Defense-in-depth: `schema` is driver-derived (already validated), but it
    // is passed to pg_dump as `--schema=<schema>`. spawn() uses an argv array
    // (no shell), so this can't inject a command, but a malformed schema would
    // still target the wrong objects, so reject it loudly.
    assertSafeIdentifier(schema, 'tenant schema')
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const fileName = `tenant_${tenant.id}_${timestamp}.dump`
    const dir = this.getBackupDir(tenant.id)

    await mkdir(dir, { recursive: true })

    const filePath = join(dir, fileName)
    const args = [
      ...this.buildConnectionArgs(),
      '--format=custom',
      `--schema=${schema}`,
      '--compress=9',
      '--file',
      filePath,
    ]

    let size: number
    try {
      await this.runProcess('pg_dump', args, {
        PGPASSWORD: backupConfig().pgConnection.password,
      })
      size = (await stat(filePath)).size
    } catch (error) {
      // A dump that dies mid-write leaves a partial, unrestorable .dump on disk.
      // Remove it so a later restore or retention sweep never treats a corrupt
      // half-file as a real backup. Best effort: pg_dump may have failed before
      // creating the file at all, in which case the unlink is a harmless no-op.
      await unlink(filePath).catch(() => {})
      throw error
    }

    const meta: BackupMetadata = {
      file: fileName,
      size,
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      schema,
    }

    await this.#saveMetadata(tenant.id, meta)

    if (backupConfig().s3?.enabled) {
      await this.#uploadToS3(tenant.id, fileName, filePath)
    }

    await logInfo({ tenantId: tenant.id, file: fileName, size }, 'Backup completed')
    return meta
  }

  async restore(tenant: TenantModelContract, fileName: string): Promise<void> {
    // Validate the filename gate BEFORE acquiring (or failing closed on) the
    // lock: a path-traversal attempt is a cheap, deterministic rejection that
    // shouldn't depend on Redis being up.
    if (!FILE_PATTERN.test(fileName)) {
      throw new Error(`Invalid backup file name: ${fileName}`)
    }
    // Serialise against any other backup/restore/clone/import of this tenant.
    // Destructive op: fail closed when the lock is unavailable (default).
    return withTenantOperationLock(
      tenant.id,
      'restore',
      () => this.#restoreLocked(tenant, fileName),
      { failClosed: destructiveLockFailClosed() }
    )
  }

  async #restoreLocked(tenant: TenantModelContract, fileName: string): Promise<void> {
    const schema = tenant.schemaName
    assertSafeIdentifier(schema, 'tenant schema')
    const filePath = join(this.getBackupDir(tenant.id), fileName)

    if (backupConfig().s3?.enabled) {
      await this.#downloadFromS3(tenant.id, fileName, filePath)
    }

    // Reject a symlink planted in the backup directory before handing the path
    // to pg_restore. FILE_PATTERN already blocks path traversal in the name, but
    // a symlink whose name passes the pattern could still point pg_restore at an
    // arbitrary file outside the backup dir. lstat does not follow the link.
    await assertRegularFile(filePath)

    const args = [
      ...this.buildConnectionArgs(),
      '--format=custom',
      `--schema=${schema}`,
      '--clean',
      '--if-exists',
      filePath,
    ]

    await this.runProcess('pg_restore', args, {
      PGPASSWORD: backupConfig().pgConnection.password,
    })
    await logInfo({ tenantId: tenant.id, file: fileName }, 'Restore completed')
  }

  async listBackups(tenantId: string): Promise<BackupMetadata[]> {
    return this.#loadMetadata(tenantId)
  }

  async deleteBackup(tenantId: string, fileName: string): Promise<void> {
    if (!FILE_PATTERN.test(fileName)) {
      throw new Error(`Invalid backup file name: ${fileName}`)
    }

    const filePath = join(this.getBackupDir(tenantId), fileName)
    await unlink(filePath).catch(() => {})

    if (backupConfig().s3?.enabled) {
      await this.#deleteFromS3(tenantId, fileName).catch((error) =>
        logWarn(
          { tenantId, file: fileName, error: error?.message },
          'Failed to delete backup from S3'
        )
      )
    }

    const list = await this.#loadMetadata(tenantId)
    const updated = list.filter((m) => m.file !== fileName)
    await this.#persistMetadata(tenantId, updated)
  }

  async #saveMetadata(tenantId: string, meta: BackupMetadata): Promise<void> {
    const list = await this.#loadMetadata(tenantId)
    list.unshift(meta)
    const capped = list.slice(0, 30)
    await this.#persistMetadata(tenantId, capped)
  }

  async #persistMetadata(tenantId: string, list: BackupMetadata[]): Promise<void> {
    const json = JSON.stringify(list)
    const redis = await lazyRedis()
    // Two redundant stores (Redis + a filesystem sidecar). Swallowing ONE leg is
    // resilience; swallowing BOTH silently loses the manifest, so `listBackups`
    // goes blind to an existing dump. Log each failed leg and throw only when
    // both fail, so a caller (and ops) learns the backup is unindexed.
    const results = await Promise.allSettled([
      redis
        ? redis.setex(this.metaKey(tenantId), backupConfig().metadataTtl, json)
        : Promise.reject(new Error('redis unavailable')),
      writeFile(this.sidecarPath(tenantId), json, 'utf-8'),
    ])
    const [redisResult, fileResult] = results
    if (redisResult.status === 'rejected' && redis) {
      await logWarn(
        { tenantId, error: (redisResult.reason as Error)?.message },
        'Failed to persist backup metadata to Redis'
      )
    }
    if (fileResult.status === 'rejected') {
      await logWarn(
        { tenantId, error: (fileResult.reason as Error)?.message },
        'Failed to persist backup metadata sidecar to disk'
      )
    }
    if (redisResult.status === 'rejected' && fileResult.status === 'rejected') {
      throw new Error(
        `Failed to persist backup metadata for tenant ${tenantId} to BOTH Redis and disk — ` +
          `the backup file is unindexed and will not appear in listBackups().`
      )
    }
  }

  async #loadMetadata(tenantId: string): Promise<BackupMetadata[]> {
    try {
      const redis = await lazyRedis()
      const raw = await redis?.get(this.metaKey(tenantId))
      if (raw) return JSON.parse(raw) as BackupMetadata[]
    } catch {}

    try {
      const raw = await readFile(this.sidecarPath(tenantId), 'utf-8')
      return JSON.parse(raw) as BackupMetadata[]
    } catch {}

    return []
  }

  async #uploadToS3(tenantId: string, fileName: string, filePath: string): Promise<void> {
    const s3cfg = backupConfig().s3!
    // @ts-ignore — @aws-sdk/client-s3 is an optional peer dependency
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')
    const { createReadStream } = await import('node:fs')

    const client = new S3Client({
      region: s3cfg.region,
      endpoint: s3cfg.endpoint || undefined,
      credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
    })

    await client.send(
      new PutObjectCommand({
        Bucket: s3cfg.bucket,
        Key: `${tenantId}/${fileName}`,
        Body: createReadStream(filePath),
        ContentType: 'application/octet-stream',
      })
    )
    await logInfo({ tenantId, file: fileName }, 'Backup uploaded to S3')
  }

  async #deleteFromS3(tenantId: string, fileName: string): Promise<void> {
    const s3cfg = backupConfig().s3!
    // @ts-ignore — @aws-sdk/client-s3 is an optional peer dependency
    const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      region: s3cfg.region,
      endpoint: s3cfg.endpoint || undefined,
      credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
    })
    await client.send(
      new DeleteObjectCommand({ Bucket: s3cfg.bucket, Key: `${tenantId}/${fileName}` })
    )
    await logInfo({ tenantId, file: fileName }, 'Backup deleted from S3')
  }

  async #downloadFromS3(tenantId: string, fileName: string, destPath: string): Promise<void> {
    const { stat: fstat } = await import('node:fs/promises')
    const exists = await fstat(destPath)
      .then(() => true)
      .catch(() => false)
    if (exists) return

    const s3cfg = backupConfig().s3!
    // @ts-ignore — @aws-sdk/client-s3 is an optional peer dependency
    const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3')
    const { createWriteStream } = await import('node:fs')
    const { pipeline } = await import('node:stream/promises')
    const { Readable } = await import('node:stream')

    const client = new S3Client({
      region: s3cfg.region,
      endpoint: s3cfg.endpoint || undefined,
      credentials: { accessKeyId: s3cfg.accessKeyId, secretAccessKey: s3cfg.secretAccessKey },
    })

    const res = await client.send(
      new GetObjectCommand({ Bucket: s3cfg.bucket, Key: `${tenantId}/${fileName}` })
    )

    const dir = this.getBackupDir(tenantId)
    await mkdir(dir, { recursive: true })
    await pipeline(Readable.from(res.Body as any), createWriteStream(destPath))
    await logInfo({ tenantId, file: fileName }, 'Backup downloaded from S3')
  }

  /**
   * Spawn `pg_dump` / `pg_restore` and resolve on a clean exit. `protected` so a
   * test can substitute a process that fails mid-write (no real Postgres needed)
   * to exercise the partial-artifact cleanup in {@link backup}.
   */
  protected runProcess(
    command: string,
    args: string[],
    processEnv: Record<string, string>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        env: { ...process.env, ...processEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const stderr: string[] = []
      proc.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))

      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`${command} exited with code ${code}: ${stderr.join('')}`))
        }
      })

      proc.on('error', reject)
    })
  }
}
