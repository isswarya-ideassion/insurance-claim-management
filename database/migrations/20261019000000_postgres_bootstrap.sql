-- Platform objects the schema relies on, created in plain PostgreSQL.
--
-- auth.users is the API's own credential store (email, password hash, profile
-- metadata). auth.uid() reads the user id that a caller puts in the
-- request.jwt.claims setting, which the row-level-security policies use.
-- The anon and authenticated roles are the database roles those policies are
-- written for (plain NOLOGIN roles, so CREATEROLE is enough to create them).
-- storage.buckets only exists so that migration 20261019000005 applies; file
-- contents live in public.document_files (0009).
--
-- Every statement is idempotent. Creating roles needs the CREATEROLE privilege.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end;
$$;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  -- scrypt$<salt>$<hash> for passwords set by this API; $2a$/$2b$ bcrypt for
  -- accounts imported from Supabase (re-hashed with scrypt at their next sign-in).
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
