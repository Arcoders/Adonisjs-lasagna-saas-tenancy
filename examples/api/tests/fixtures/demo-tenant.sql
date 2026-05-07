-- Deterministic seed dump consumed by the backups_real.spec.ts test.
-- The importer rewrites `public.` → `tenant_<id>.` when invoked with
-- `--schema-replace public`. We deliberately use INSERTs (not COPY) so the
-- import does not require the `psql` CLI for stdin streaming.

-- A new table that is NOT in the per-tenant migrations. Its presence after
-- import is the unambiguous proof that the dump was applied.
CREATE TABLE IF NOT EXISTS public.widgets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.widgets (name) VALUES ('alpha');
INSERT INTO public.widgets (name) VALUES ('beta');
INSERT INTO public.widgets (name) VALUES ('gamma');

-- The `notes` table already exists in the tenant schema (created by the
-- 0001_create_notes_table migration). We append two known rows so the
-- import test can also assert row-merge behaviour.
INSERT INTO public.notes (title, body) VALUES ('Imported #1', 'from sql dump');
INSERT INTO public.notes (title, body) VALUES ('Imported #2', 'from sql dump');
