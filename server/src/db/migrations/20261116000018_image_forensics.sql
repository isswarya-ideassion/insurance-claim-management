-- Beacon AI Image Forensics (November 16, 2026).
--
-- Local, zero-cost checks on image documents (duplicate file across claims,
-- editing-software / generative-AI metadata, capture date before the loss,
-- OCR'd bill total and date against the claim). When a person accepts an
-- alert, a flag is recorded with one of these reason codes for compliance to
-- review. The alert itself is stored in ai_runs (agent 'image-forensics', or
-- on the intake-parser / triage-router run it was attached to).

insert into public.fraud_reason_codes (code, description, category, weight, active) values
  ('DOCUMENT_TAMPERING',       'Image metadata shows editing software, generative AI or edits after capture', 'EVIDENCE', 45, true),
  ('DUPLICATE_DOCUMENT_IMAGE', 'The identical image file is filed on another claim',                          'PATTERN',  40, true),
  ('IMAGE_PREDATES_LOSS',      'Embedded capture date is earlier than the date of loss',                      'TIMING',   30, true)
on conflict (code) do nothing;

-- Finding earlier uploads of the same file is a lookup by hash.
create index if not exists document_files_sha256_idx on public.document_files (sha256);
