import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "supabase/migrations");

/**
 * Runs the real project migrations (supabase/migrations/*.sql, unmodified)
 * against an in-process WASM Postgres, with a minimal mock of the
 * Supabase platform pieces our SQL depends on but that don't exist outside
 * a real Supabase project: `auth.users`/`auth.uid()`, and a trimmed-down
 * `storage.buckets`/`storage.objects`/`storage.foldername()` (enough for
 * 0018_document_storage.sql's policies to be exercised for real — the
 * mock matches Supabase's actual column/function shapes closely enough
 * for those policies specifically, not a general Storage reimplementation).
 *
 * This lets RLS policies be exercised by an actual Postgres planner/executor
 * — not re-implemented in JS — which is what makes the tenant-isolation
 * tests in this directory a real verification rather than a read-through.
 *
 * One accommodation: PGlite doesn't ship the `pgcrypto` extension. Every
 * statement runs except `create extension "pgcrypto"`, which is skipped —
 * `gen_random_uuid()` has been a Postgres core function since PG13 (the
 * version this schema targets), so the extension line matters for a real
 * Supabase project (which does provide it) but isn't required for the
 * function to work here.
 */
export async function createTestDatabase() {
  const db = new PGlite();

  // A real Supabase project has `anon`/`authenticated`/`service_role`
  // provisioned before any user migration ever runs — these must exist
  // *before* the migration loop below, not after, since
  // 0023_grant_data_api_privileges.sql (a real, unmodified migration)
  // grants privileges to them directly.
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
  `);

  await db.exec(`
    create schema auth;

    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );

    create or replace function auth.uid() returns uuid
    language sql stable
    as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;

    create schema storage;

    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false
    );

    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text references storage.buckets (id),
      name text,
      owner uuid,
      created_at timestamptz not null default now()
    );

    alter table storage.objects enable row level security;

    create or replace function storage.foldername(name text)
    returns text[]
    language plpgsql
    as $$
    declare
      _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[1:array_length(_parts, 1) - 1];
    end;
    $$;
  `);

  const migrationFiles = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of migrationFiles) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const statements = splitStatements(sql);
    for (const statement of statements) {
      if (/create extension/i.test(statement)) continue;
      await db.exec(statement);
    }
  }

  // The `public` schema grants for `anon`/`authenticated`/`service_role`
  // now come from 0023_grant_data_api_privileges.sql itself, run above as
  // part of the real migration set — mirroring it by hand here would let
  // this harness silently drift from what's actually deployed. Only the
  // auth/storage *mock* schemas (defined above, not part of the real
  // Supabase-managed schema) still need their grants added explicitly:
  // without these, every query touching them fails with "permission
  // denied" before RLS is even evaluated, which would mask what these
  // tests are actually checking.
  await db.exec(`
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant usage on schema storage to authenticated;
    grant select, insert, delete on storage.objects to authenticated;
    grant select on storage.buckets to authenticated;
    grant execute on function storage.foldername(text) to authenticated;
  `);

  return new TestDatabase(db);
}

/** Naive but sufficient splitter: none of our migration SQL uses `$$`-quoted
 *  bodies containing a literal `; ` followed by more top-level statements
 *  outside the function body in a way this would mis-split, except that
 *  dollar-quoted function bodies themselves contain semicolons — so we
 *  split on `;\n` only outside `$$ ... $$` blocks. */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;

  const lines = sql.split("\n");
  for (const line of lines) {
    if (line.trim().startsWith("--")) continue;
    current += line + "\n";
    const dollarMatches = line.match(/\$\$/g);
    if (dollarMatches) {
      for (let i = 0; i < dollarMatches.length; i++) {
        inDollarQuote = !inDollarQuote;
      }
    }
    if (!inDollarQuote && /;\s*$/.test(line.trim())) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
    }
  }
  const remainder = current.trim();
  if (remainder.length > 0) statements.push(remainder);
  return statements;
}

export class TestDatabase {
  constructor(private db: PGlite) {}

  /** Runs `fn` as the Postgres superuser, bypassing RLS entirely — for
   *  seeding fixtures, not for anything a test is asserting about. */
  async asAdmin<T>(fn: (query: TestDatabase["query"]) => Promise<T>): Promise<T> {
    await this.db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
    return fn(this.query.bind(this));
  }

  /** Runs subsequent queries as `authenticated`, with `auth.uid()` resolving
   *  to `userId` — i.e. exactly the session a real logged-in request has. */
  async asUser(userId: string) {
    await this.db.exec(
      `set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`,
    );
  }

  query = async (sql: string, params: unknown[] = []) => {
    return this.db.query(sql, params);
  };

  close() {
    return this.db.close();
  }
}
