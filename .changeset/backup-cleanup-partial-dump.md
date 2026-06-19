---
"@adonisjs-lasagna/backup": patch
---

Remove the partial dump file when `pg_dump` fails. A backup whose dump died
mid-write (a dropped DB connection, a vanished schema, a full disk) left an
unrestorable half-`.dump` on disk, which a later `restore` or a retention sweep
could pick up as if it were a real backup. `BackupService.backup()` now unlinks
the partial artifact on any dump failure and rethrows, so a failed backup leaves
no trace. Covered by a new unit spec (a stubbed process that writes a partial
then throws) and an end-to-end spec that fails a real `pg_dump` and asserts no
`.dump` survives.
