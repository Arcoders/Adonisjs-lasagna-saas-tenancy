/**
 * pgvector placement constants, shared by the provisioning step, the schema-pg
 * driver, and the doctor check so the three cannot drift.
 *
 * The `vector` type and its operator classes (`vector_cosine_ops`, `<=>`) are
 * installed ONCE into a dedicated `extensions` schema rather than `public`. That
 * schema is then appended to every schema-pg tenant connection's search_path so a
 * bare `vector(N)` column and a bare operator class resolve during a per-tenant
 * migration and at query time, while the tenant's own schema stays FIRST, so all
 * tenant data objects still shadow anything shared. The extensions schema carries
 * NO data (only the extension objects), so physical per-tenant isolation is
 * preserved: `public`, which in this design holds central/default-connection
 * tables, is deliberately kept OFF the tenant search_path.
 *
 * This is a leaf module (it imports nothing from the isolation graph) so the
 * driver can read it without an import cycle through `vector_provisioning`.
 */

/** The PostgreSQL extension that backs the vector store. */
export const PGVECTOR_EXTENSION = 'vector'

/**
 * The dedicated schema the `vector` extension is installed into and which is
 * appended to schema-pg tenant connections' search_path. Holds only the
 * extension objects, never tenant data.
 */
export const PGVECTOR_EXTENSION_SCHEMA = 'extensions'
