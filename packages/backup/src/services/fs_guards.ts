import { lstat } from 'node:fs/promises'

/**
 * Reject a non-regular file (symlink, directory, socket) before handing its path
 * to a child process such as pg_restore or psql. Uses lstat so a symlink is
 * detected rather than transparently followed: a symlink whose name passes the
 * backup-file pattern could still point the child process at an arbitrary file
 * outside the backup directory.
 *
 * No booted-app imports, so it loads in a bare unit runner.
 */
export async function assertRegularFile(filePath: string): Promise<void> {
  const st = await lstat(filePath)
  if (st.isSymbolicLink()) {
    throw new Error(
      `Refusing to use a symlink as a backup file: ${filePath}. Backup entries must be regular files.`
    )
  }
  if (!st.isFile()) {
    throw new Error(`Backup path is not a regular file: ${filePath}`)
  }
}
