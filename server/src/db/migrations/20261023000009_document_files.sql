-- Claim document contents are stored in PostgreSQL (no external object store).
-- One row per stored object, addressed by the storage_key that documents and
-- document_versions already record. Rows are write-once: a new version of a
-- document is a new key, so an object is never overwritten.

create table if not exists public.document_files (
  storage_key text primary key,
  content bytea not null,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null,
  created_at timestamptz not null default now()
);

-- Large values are stored out of line; skip compression for already-compressed formats.
alter table public.document_files alter column content set storage external;

create or replace function public.document_files_write_once() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'IMMUTABLE_RECORD: stored document files cannot be modified' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' and coalesce(current_setting('app.allow_file_delete', true), 'off') <> 'on' then
    raise exception 'IMMUTABLE_RECORD: stored document files cannot be deleted' using errcode = 'P0001';
  end if;
  return coalesce(old, new);
end;
$$;

drop trigger if exists document_files_write_once on public.document_files;
create trigger document_files_write_once
  before update or delete on public.document_files
  for each row execute function public.document_files_write_once();

-- Only the API reads files, after its own access check; no direct access for user roles.
alter table public.document_files enable row level security;
revoke all on public.document_files from anon, authenticated;

-- The Supabase bucket record has no meaning without Supabase Storage.
drop schema if exists storage cascade;
