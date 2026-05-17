import { test } from '@japa/runner'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import {
  BackupService,
  BackupRetentionService,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'

/**
 * Backup S3 roundtrip against a real S3-compatible store. SKIPPED unless
 * `BACKUP_S3_ENDPOINT` is set (CI provides one via the `minio` service).
 *
 * Why not just unit-test the S3 codepath: the package's S3 branch uses
 * `@aws-sdk/client-s3` with `forcePathStyle=false` and a custom
 * `endpoint`, which is exactly the shape that breaks when consumers
 * wire it against non-AWS S3 implementations (minio, R2, B2…). The
 * mock-friendly happy path passes everywhere; the real roundtrip
 * catches sign-v4 mismatches, region-aware redirects, and bucket-policy
 * quirks.
 *
 * What this spec proves end-to-end:
 *   1. `BackupService.deleteBackup()` removes objects from S3
 *      (HEAD afterwards yields 404) — exercises `#deleteFromS3`
 *      with the same SDK params the package builds at runtime.
 *   2. `BackupRetentionService.applyRetention()` deletes the right
 *      objects from S3 when wired with `keepLast: 2` over 5 seeded
 *      objects — exercises the loop over the metadata sidecar.
 *
 * What this spec deliberately skips:
 *   - The `pg_dump` half of `backup()`. That's covered by
 *     `examples/api/tests/e2e/backups_real.spec.ts` against local
 *     storage; here we focus on the S3 wire path. We seed test
 *     artefacts via the SDK directly + a hand-written sidecar JSON.
 */
const ENDPOINT = process.env.BACKUP_S3_ENDPOINT
const SHOULD_RUN = typeof ENDPOINT === 'string' && ENDPOINT.length > 0

const BUCKET = process.env.BACKUP_S3_BUCKET ?? 'multitenancy-backups-test'
const REGION = process.env.BACKUP_S3_REGION ?? 'us-east-1'
const ACCESS_KEY = process.env.AWS_ACCESS_KEY_ID ?? 'minioadmin'
const SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY ?? 'minioadmin'

function makeClient(): S3Client {
  return new S3Client({
    region: REGION,
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  })
}

function fakeTenant(id = randomUUID()) {
  return {
    id,
    name: `t-${id.slice(0, 8)}`,
    schemaName: `tenant_${id}`,
    isActive: true,
    isSuspended: false,
    isProvisioning: false,
    isFailed: false,
    isDeleted: false,
  } as any
}

async function seedObject(
  client: S3Client,
  tenantId: string,
  fileName: string,
  body: Buffer | string
): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${tenantId}/${fileName}`,
      Body: typeof body === 'string' ? Buffer.from(body, 'utf8') : body,
    })
  )
}

async function objectExists(
  client: S3Client,
  tenantId: string,
  fileName: string
): Promise<boolean> {
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: `${tenantId}/${fileName}` })
    )
    return true
  } catch (err: any) {
    if (err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404) return false
    throw err
  }
}

test.group('BackupService — S3 roundtrip (real backend)', (group) => {
  let tmpRoot: string
  let originalConfig: ReturnType<typeof getConfig>
  let client: S3Client | undefined

  group.setup(async () => {
    if (!SHOULD_RUN) return
    tmpRoot = join(tmpdir(), `lasagna-backup-s3-${randomUUID()}`)
    await mkdir(tmpRoot, { recursive: true })
    client = makeClient()
    await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch((err: any) => {
      if (err?.name !== 'BucketAlreadyOwnedByYou' && err?.name !== 'BucketAlreadyExists') {
        throw err
      }
    })
  })

  group.each.setup(() => {
    if (!SHOULD_RUN) return
    originalConfig = getConfig()
    setConfig({
      ...originalConfig,
      backup: {
        ...originalConfig.backup,
        storagePath: tmpRoot,
        s3: {
          enabled: true,
          bucket: BUCKET,
          region: REGION,
          endpoint: ENDPOINT!,
          accessKeyId: ACCESS_KEY,
          secretAccessKey: SECRET_KEY,
        },
      },
    } as any)
  })

  group.each.teardown(() => {
    if (!SHOULD_RUN) return
    setConfig(originalConfig)
  })

  group.teardown(async () => {
    if (!SHOULD_RUN || !client) return
    const listed = await client
      .send(new ListObjectsV2Command({ Bucket: BUCKET }))
      .catch(() => ({ Contents: [] }) as any)
    for (const obj of listed.Contents ?? []) {
      if (obj.Key) {
        await client
          .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }))
          .catch(() => {})
      }
    }
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test('deleteBackup() removes the object from S3 (HEAD → 404)', async ({ assert }) => {
    const t = fakeTenant()
    const fileName = `tenant_${t.id}_2026-05-13T00-00-00-000Z.dump`
    await seedObject(client!, t.id, fileName, `synthetic-${randomUUID()}`)
    assert.isTrue(await objectExists(client!, t.id, fileName), 'precondition: object exists in S3')

    // Persist a minimal sidecar so deleteBackup can update metadata
    // without needing a Redis hit (the service tolerates either source).
    const dir = join(tmpRoot, t.id)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'backup.json'),
      JSON.stringify([
        {
          file: fileName,
          size: 16,
          timestamp: new Date().toISOString(),
          tenantId: t.id,
          schema: t.schemaName,
        },
      ])
    )

    const svc = new BackupService()
    await svc.deleteBackup(t.id, fileName)

    assert.isFalse(
      await objectExists(client!, t.id, fileName),
      'deleteBackup() must remove the object from S3'
    )
  }).skip(!SHOULD_RUN, 'BACKUP_S3_ENDPOINT not set — S3 roundtrip skipped')

  test('applyRetention() purges only the surplus objects from S3', async ({ assert }) => {
    const t = fakeTenant()
    const fileNames: string[] = []
    const sidecarEntries: any[] = []

    for (let i = 0; i < 5; i++) {
      const fileName = `tenant_${t.id}_2026-05-${String(13 + i).padStart(2, '0')}T00-00-00-000Z.dump`
      await seedObject(client!, t.id, fileName, `synthetic-${i}`)
      fileNames.push(fileName)
      sidecarEntries.push({
        file: fileName,
        size: 16,
        // Spread timestamps so the retention sort is deterministic.
        timestamp: new Date(Date.now() - (5 - i) * 60_000).toISOString(),
        tenantId: t.id,
        schema: t.schemaName,
      })
    }

    const dir = join(tmpRoot, t.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'backup.json'), JSON.stringify(sidecarEntries))

    setConfig({
      ...getConfig(),
      backup: {
        ...getConfig().backup,
        retention: {
          defaultTier: 'small',
          tiers: { small: { intervalHours: 24, keepLast: 2 } },
        },
      },
    } as any)

    const plan = await new BackupRetentionService().applyRetention(t)
    assert.lengthOf(plan.kept, 2, 'retention must keep `keepLast` backups')
    assert.lengthOf(plan.purged, 3, 'the surplus must be purged')

    // The S3 truth must match the plan — purged files gone, kept files present.
    for (const purged of plan.purged) {
      assert.isFalse(
        await objectExists(client!, t.id, purged.file),
        `purged file must be removed from S3: ${purged.file}`
      )
    }
    for (const kept of plan.kept) {
      assert.isTrue(
        await objectExists(client!, t.id, kept.file),
        `kept file must remain in S3: ${kept.file}`
      )
    }
  }).skip(!SHOULD_RUN, 'BACKUP_S3_ENDPOINT not set — S3 roundtrip skipped')
})
