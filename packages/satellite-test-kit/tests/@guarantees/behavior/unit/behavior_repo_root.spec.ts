import { test } from '@japa/runner'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repoRoot, resolveWorkspaceRoot, readPackageManifest } from '../../../../src/repo_root.js'

test.group('resolveWorkspaceRoot (pure)', () => {
  test('returns the start dir when it declares workspaces', ({ assert }) => {
    const root = resolveWorkspaceRoot('/repo', {
      readManifest: (dir) => (dir === '/repo' ? { workspaces: ['packages/*'] } : undefined),
      parentOf: (dir) => dir.split('/').slice(0, -1).join('/') || '/',
    })
    assert.equal(root, '/repo')
  })

  test('walks up until it finds the workspaces marker', ({ assert }) => {
    const root = resolveWorkspaceRoot('/repo/packages/core/tests/@architecture/docs', {
      readManifest: (dir) =>
        dir === '/repo'
          ? { workspaces: [] }
          : dir === '/repo/packages/core'
            ? {} // a package.json WITHOUT workspaces must not match
            : undefined,
      parentOf: (dir) => dir.split('/').slice(0, -1).join('/') || '/',
    })
    assert.equal(root, '/repo')
  })

  test('throws when no ancestor declares workspaces', ({ assert }) => {
    assert.throws(
      () =>
        resolveWorkspaceRoot('/a/b', {
          readManifest: () => undefined,
          parentOf: (dir) => (dir === '/' ? '/' : dir.split('/').slice(0, -1).join('/') || '/'),
        }),
      /no package\.json with a "workspaces" field/
    )
  })
})

test.group('readPackageManifest (fs)', () => {
  test('parses a present manifest, and returns undefined for absent or malformed', ({ assert }) => {
    const dir = mkdtempSync(join(tmpdir(), 'lasagna-repo-root-'))
    try {
      assert.isUndefined(readPackageManifest(dir)) // absent

      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', workspaces: ['a/*'] }))
      assert.deepEqual(readPackageManifest(dir), { name: 'x', workspaces: ['a/*'] })

      writeFileSync(join(dir, 'package.json'), '{ not json')
      assert.isUndefined(readPackageManifest(dir)) // malformed -> catch
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test.group('repoRoot (fs)', () => {
  test('resolves the monorepo root from a file: URL', ({ assert }) => {
    const root = repoRoot(import.meta.url)
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    assert.property(manifest, 'workspaces')
  })

  test('resolves from a plain directory path too', ({ assert }) => {
    const fromUrl = repoRoot(import.meta.url)
    const fromDir = repoRoot(join(fromUrl, 'packages', 'satellite-test-kit'))
    assert.equal(fromDir, fromUrl)
  })
})
