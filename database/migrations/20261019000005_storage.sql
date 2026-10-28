-- Private bucket for claim documents. No storage.objects policies are granted to
-- anon/authenticated, so only the backend (service role) can read or write
-- objects; downloads are streamed through the API after an authorization check.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'claim-documents',
  'claim-documents',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
