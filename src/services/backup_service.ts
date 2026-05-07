import { spawn } from 'node:child_process'
import { mkdir, unlink, stat, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfig } from '../config.js'
import type { TenantModelContract } from '../types/contracts.js'

const lazyRedis = () =>
  import('@adonisjs/redis/services/main')
    .then((m) => m.default)
    .catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger')
    .then((m) => m.default)
    .catch(() => null)

async function logInfo(payload: Record<string, unknown>, msg: string): Promise<void> {
  const log = await lazyLogger()
  log?.info(payload, msg)
}

async function logWarn(payload: Record<string, unknown>, msg: string): Promise<void> {
  const log = await lazyLogger()
  log?.warn(payload, msg)
}

export interface BackupMetadata {
  file: string
  size: number
  timestamp: string
  tenantId: string
  schema: string
}

// Accept the filenames our own producer writes:
//   tenant_<uuid>_<ISO timestamp with `:` / `.` rewritten to `-`>.dump
// e.g. tenant_abcd_2026-05-02T16-16-36-264Z.dump
// Path traversal (`/`, `\`, `..`) is still rejected by virtue of not being in
// the character class.
const FILE_PATTERN = /^[A-Za-z0-9._-]+\.dump$/

export default class BackupService {
  private getBackupDir(tenantId: string): string {
    return join(getConfig().backup.storagePath, tenantId)
  }

  private metaKey(tenantId: string): string {
    return `backup:meta:${tenantId}`
  }

  private sidecarPath(tenantId: string): string {
    return join(this.getBackupDir(tenantId), 'backup.json')
  }

  private buildConnectionArgs(): string[] {
    const { host, port, user, database } = getConfig().backup.pgConnection
    return ['-h', host, '-p', String(port), '-U', user, '-d', database]
  }

  async backup(tenant: TenantModelContract): Promise<BackupMetadata> {
    const schema = tenant.schemaName
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

    await this.#runProcess('pg_dump', args, {
      PGPASSWORD: getConfig().backup.pgConnection.password,
    })

    const { size } = await stat(filePath)

    const meta: BackupMetadata = {
      file: fileName,
      size,
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      schema,
    }

    await this.#saveMetadata(tenant.id, meta)

    if (getConfig().backup.s3?.enabled) {
      await this.#uploadToS3(tenant.id, fileName, filePath)
    }

    await logInfo({ tenantId: tenant.id, file: fileName, size }, 'Backup completed')
    return meta
  }

  async restore(tenant: TenantModelContract, fileName: string): Promise<void> {
    if (!FILE_PATTERN.test(fileName)) {
      throw new Error(`Invalid backup file name: ${fileName}`)
    }

    const schema = tenant.schemaName
    const filePath = join(this.getBackupDir(tenant.id), fileName)

    if (getConfig().backup.s3?.enabled) {
      await this.#downloadFromS3(tenant.id, fileName, filePath)
    }

    const args = [
      ...this.buildConnectionArgs(),
      '--format=custom',
      `--schema=${schema}`,
      '--clean',
      '--if-exists',
      filePath,
    ]

    await this.#runProcess('pg_restore', args, {
      PGPASSWORD: getConfig().backup.pgConnection.password,
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

    if (getConfig().backup.s3?.enabled) {
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
    await Promise.all([
      redis
        ?.setex(this.metaKey(tenantId), getConfig().backup.metadataTtl, json)
        .catch(() => {}),
      writeFile(this.sidecarPath(tenantId), json, 'utf-8').catch(() => {}),
    ])
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
    const s3cfg = getConfig().backup.s3!
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
    const s3cfg = getConfig().backup.s3!
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

    const s3cfg = getConfig().backup.s3!
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

  #runProcess(command: string, args: string[], processEnv: Record<string, string>): Promise<void> {
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
