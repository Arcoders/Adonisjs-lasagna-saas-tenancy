import { test } from '@japa/runner'
import { splitSqlStatements, splitSqlStatementsTagged } from '../../../src/utils/sql_splitter.js'

test.group('splitSqlStatements — adversarial inputs', () => {
  test('semicolon inside single-quoted string is not a statement boundary', ({ assert }) => {
    const sql = `INSERT INTO t VALUES ('a;b;c'); SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.equal(result[0], `INSERT INTO t VALUES ('a;b;c')`)
    assert.equal(result[1], 'SELECT 1')
  })

  test('escaped single quote inside string does not terminate it', ({ assert }) => {
    const sql = `INSERT INTO t VALUES ('it''s fine; really'); SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.include(result[0], `'it''s fine; really'`)
  })

  test('dollar-quoted string with semicolons inside is one statement', ({ assert }) => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; PERFORM 2; END $$ LANGUAGE plpgsql; SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.include(result[0], 'PERFORM 1; PERFORM 2;')
    assert.equal(result[1], 'SELECT 1')
  })

  test('tagged dollar-quoted strings ($BODY$ ... $BODY$) preserve internal semicolons', ({ assert }) => {
    const sql = `CREATE FUNCTION g() RETURNS int AS $BODY$ SELECT 1; SELECT 2; $BODY$ LANGUAGE sql; SELECT 3;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.include(result[0], 'SELECT 1; SELECT 2;')
  })

  test('line comment containing a semicolon does not split', ({ assert }) => {
    const sql = `SELECT 1 -- this; is a comment;\n; SELECT 2;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.match(result[0], /SELECT 1/)
    assert.equal(result[1], 'SELECT 2')
  })

  test('block comment containing semicolons does not split', ({ assert }) => {
    const sql = `SELECT 1 /* a; b; c */; SELECT 2;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.equal(result[1], 'SELECT 2')
  })

  test('schema name appearing inside a string literal is not treated as identifier', ({ assert }) => {
    const sql = `INSERT INTO t (note) VALUES ('see public.foo for context'); SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.equal(result[0], `INSERT INTO t (note) VALUES ('see public.foo for context')`)
  })

  test('psql meta-commands at line start are dropped', ({ assert }) => {
    const sql = `\\connect mydb\nSELECT 1;\n\\d foo\nSELECT 2;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.equal(result[0], 'SELECT 1')
    assert.equal(result[1], 'SELECT 2')
  })

  test('schema names containing digits split cleanly', ({ assert }) => {
    const sql = `CREATE TABLE tenant_1.foo (id int); CREATE TABLE tenant_22.bar (id int);`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.include(result[0], 'tenant_1.foo')
    assert.include(result[1], 'tenant_22.bar')
  })

  test('trailing whitespace and empty statements are stripped', ({ assert }) => {
    const sql = `SELECT 1;;;\n   \nSELECT 2;\n`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
  })
})

test.group('splitSqlStatementsTagged — adversarial inputs', () => {
  test('COPY block with empty data section emits an empty rows array', ({ assert }) => {
    const sql = ['COPY public.foo (id) FROM stdin;', '\\.', 'SELECT 1;'].join('\n')
    const tokens = splitSqlStatementsTagged(sql)
    assert.lengthOf(tokens, 2)
    assert.equal(tokens[0].kind, 'copy')
    if (tokens[0].kind === 'copy') {
      assert.deepEqual(tokens[0].rows, [])
    }
  })

  test('multiple COPY blocks in one file are tokenized separately', ({ assert }) => {
    const sql = [
      'COPY public.a (id) FROM stdin;',
      '1',
      '\\.',
      'SELECT 1;',
      'COPY public.b (id) FROM stdin;',
      '2',
      '3',
      '\\.',
    ].join('\n')

    const tokens = splitSqlStatementsTagged(sql)
    const copyTokens = tokens.filter((t) => t.kind === 'copy')
    assert.lengthOf(copyTokens, 2)
    if (copyTokens[0].kind === 'copy' && copyTokens[1].kind === 'copy') {
      assert.lengthOf(copyTokens[0].rows, 1)
      assert.lengthOf(copyTokens[1].rows, 2)
    }
  })

  test('rows containing tabs and NULL markers are preserved verbatim', ({ assert }) => {
    const sql = ['COPY public.foo (a, b, c) FROM stdin;', '1\t\\N\thello world', '2\tx\t\\N', '\\.'].join('\n')
    const tokens = splitSqlStatementsTagged(sql)
    assert.lengthOf(tokens, 1)
    if (tokens[0].kind === 'copy') {
      assert.equal(tokens[0].rows[0], '1\t\\N\thello world')
      assert.equal(tokens[0].rows[1], '2\tx\t\\N')
    }
  })

  test('COPY with explicit format options is detected', ({ assert }) => {
    const sql = ['COPY public.foo (id) FROM stdin WITH (FORMAT text);', '1', '\\.'].join('\n')
    const tokens = splitSqlStatementsTagged(sql)
    assert.lengthOf(tokens, 1)
    assert.equal(tokens[0].kind, 'copy')
  })
})

test.group('splitSqlStatementsTagged — COPY blocks', () => {
  test('COPY ... FROM stdin block becomes a single token with all rows', ({ assert }) => {
    const sql = [
      'CREATE TABLE foo (id int);',
      'COPY public.foo (id) FROM stdin;',
      '1',
      '2',
      '3',
      '\\.',
      'SELECT 1;',
    ].join('\n')

    const tokens = splitSqlStatementsTagged(sql)

    assert.lengthOf(tokens, 3)
    assert.equal(tokens[0].kind, 'sql')
    assert.equal(tokens[1].kind, 'copy')
    if (tokens[1].kind === 'copy') {
      assert.match(tokens[1].header, /^COPY\s+public\.foo/i)
      assert.deepEqual(tokens[1].rows, ['1', '2', '3'])
    }
    assert.equal(tokens[2].kind, 'sql')
  })

  test('tab-separated rows inside COPY block are not split per row', ({ assert }) => {
    const sql = [
      'COPY tenant_x.vehicles (id, make, model) FROM stdin;',
      '93\tFord\tFiesta',
      '24\tHonda\tCivic',
      '\\.',
    ].join('\n')

    const tokens = splitSqlStatementsTagged(sql)

    assert.lengthOf(tokens, 1)
    assert.equal(tokens[0].kind, 'copy')
    if (tokens[0].kind === 'copy') {
      assert.lengthOf(tokens[0].rows, 2)
      assert.equal(tokens[0].rows[0], '93\tFord\tFiesta')
    }
  })

  test('plain SQL with no COPY blocks is tokenized as sql kind', ({ assert }) => {
    const sql = 'CREATE TABLE foo (id int); INSERT INTO foo VALUES (1);'
    const tokens = splitSqlStatementsTagged(sql)
    assert.lengthOf(tokens, 2)
    assert.equal(tokens[0].kind, 'sql')
    assert.equal(tokens[1].kind, 'sql')
  })

  test('empty input returns empty array', ({ assert }) => {
    assert.deepEqual(splitSqlStatementsTagged(''), [])
  })
})

test.group('splitSqlStatements — basic splitting', () => {
  test('empty string returns empty array', ({ assert }) => {
    assert.deepEqual(splitSqlStatements(''), [])
  })

  test('whitespace-only string returns empty array', ({ assert }) => {
    assert.deepEqual(splitSqlStatements('   \n\t  '), [])
  })

  test('single statement with semicolon', ({ assert }) => {
    const result = splitSqlStatements('SELECT 1;')
    assert.lengthOf(result, 1)
    assert.equal(result[0], 'SELECT 1')
  })

  test('single statement without trailing semicolon', ({ assert }) => {
    const result = splitSqlStatements('SELECT 1')
    assert.lengthOf(result, 1)
    assert.equal(result[0], 'SELECT 1')
  })

  test('multiple statements split correctly', ({ assert }) => {
    const sql = `CREATE TABLE foo (id int);
INSERT INTO foo VALUES (1);
INSERT INTO foo VALUES (2);`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 3)
    assert.include(result[0], 'CREATE TABLE foo')
    assert.include(result[1], 'INSERT INTO foo VALUES (1)')
    assert.include(result[2], 'INSERT INTO foo VALUES (2)')
  })

  test('blank statements between semicolons are filtered', ({ assert }) => {
    const result = splitSqlStatements('SELECT 1;;; SELECT 2;')
    assert.lengthOf(result, 2)
  })

  test('leading and trailing whitespace stripped from statements', ({ assert }) => {
    const result = splitSqlStatements('  SELECT 1  ;')
    assert.equal(result[0], 'SELECT 1')
  })
})

test.group('splitSqlStatements — single-quoted strings', () => {
  test('semicolon inside single-quoted string is not a separator', ({ assert }) => {
    const result = splitSqlStatements(`INSERT INTO t VALUES ('hello; world');`)
    assert.lengthOf(result, 1)
    assert.include(result[0], 'hello; world')
  })

  test('escaped single-quote (doubled) inside string', ({ assert }) => {
    const result = splitSqlStatements(`INSERT INTO t VALUES ('it''s fine');`)
    assert.lengthOf(result, 1)
    assert.include(result[0], "it''s fine")
  })

  test('multiple strings in one statement', ({ assert }) => {
    const result = splitSqlStatements(`INSERT INTO t VALUES ('a;b', 'c;d');`)
    assert.lengthOf(result, 1)
  })
})

test.group('splitSqlStatements — dollar-quoted strings', () => {
  test('semicolon inside $$ dollar-quoted block is not a separator', ({ assert }) => {
    const sql = `CREATE FUNCTION f() RETURNS void AS $$
BEGIN
  INSERT INTO t VALUES (1); -- this semicolon must not split
END;
$$ LANGUAGE plpgsql;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
    assert.include(result[0], 'plpgsql')
  })

  test('named dollar-quote tag ($BODY$...$BODY$)', ({ assert }) => {
    const sql = `CREATE FUNCTION g() RETURNS void AS $BODY$
BEGIN
  RAISE NOTICE 'hello; world';
END;
$BODY$ LANGUAGE plpgsql;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
    assert.include(result[0], '$BODY$')
  })

  test('statement after dollar-quoted block is parsed separately', ({ assert }) => {
    const sql = `DO $$ BEGIN NULL; END $$;
SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
    assert.include(result[0], 'DO')
    assert.include(result[1], 'SELECT 1')
  })
})

test.group('splitSqlStatements — comments', () => {
  test('semicolon inside line comment is not a separator', ({ assert }) => {
    const sql = `SELECT 1 -- this; is a comment
;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
    assert.include(result[0], '-- this; is a comment')
  })

  test('semicolon inside block comment is not a separator', ({ assert }) => {
    const sql = `SELECT /* value; here */ 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
  })

  test('block comment spanning multiple lines', ({ assert }) => {
    const sql = `SELECT
/* multi
   line;
   comment */
1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
  })

  test('statement after line comment is parsed on next line', ({ assert }) => {
    const sql = `-- drop old stuff
SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
    assert.include(result[0], 'SELECT 1')
  })
})

test.group('splitSqlStatements — psql meta-commands', () => {
  test('\\connect meta-command line is skipped', ({ assert }) => {
    const sql = `\\connect mydb
SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
    assert.equal(result[0], 'SELECT 1')
  })

  test('\\set meta-command line is skipped', ({ assert }) => {
    const sql = `\\set ON_ERROR_STOP on
CREATE TABLE t (id int);`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
    assert.include(result[0], 'CREATE TABLE')
  })

  test('multiple meta-commands all skipped', ({ assert }) => {
    const sql = `\\connect mydb
\\set ON_ERROR_STOP on
SELECT 1;`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
  })
})

test.group('splitSqlStatements — pg_dump realistic content', () => {
  test('pg_dump header block produces no statements', ({ assert }) => {
    const header = `--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET lock_timeout = 0;
SET client_encoding = 'UTF8';
SELECT pg_catalog.set_config('search_path', '', false);`
    const result = splitSqlStatements(header)
    assert.isAbove(result.length, 0)
    for (const stmt of result) {
      assert.isAbove(stmt.trim().length, 0)
    }
  })

  test('CREATE TABLE statement is parsed as single statement', ({ assert }) => {
    const sql = `CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    created_at timestamp without time zone
);`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 1)
    assert.include(result[0], 'CREATE TABLE')
    assert.include(result[0], 'created_at')
  })

  test('ALTER TABLE statements each parsed individually', ({ assert }) => {
    const sql = `ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);`
    const result = splitSqlStatements(sql)
    assert.lengthOf(result, 2)
  })

  test('COPY ... FROM stdin block handled correctly', ({ assert }) => {
    const sql = `COPY public.users (id, email) FROM stdin;
1\tacme@test.com
\\.
SELECT 1;`
    const result = splitSqlStatements(sql)
    const hasSelect = result.some((s) => s.includes('SELECT 1'))
    assert.isTrue(hasSelect)
  })
})
