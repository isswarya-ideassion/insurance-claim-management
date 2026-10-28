-- Centralized customer records (CUSTOMER_RECORDS_ADMIN) and claim automation:
-- AI run log (document extraction, claim summaries) and reminder history.

-- ---------------------------------------------------------------------------
-- Role
-- ---------------------------------------------------------------------------
insert into public.roles (code, name, description, is_staff) values
  ('CUSTOMER_RECORDS_ADMIN', 'Customer Records Admin',
   'Read-only access to every customer record (profile, policies, claim history, documents) for centralized management', true)
on conflict (code) do update
  set name = excluded.name, description = excluded.description, is_staff = excluded.is_staff;

-- ---------------------------------------------------------------------------
-- AI runs: one row per AI call, successful or not. Results are kept for
-- review and audit; applying extracted values is a separate, human step.
-- ---------------------------------------------------------------------------
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('DOCUMENT_EXTRACTION', 'CLAIM_SUMMARY')),
  claim_id uuid not null references public.claims (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  provider text not null,
  model text not null,
  status text not null check (status in ('SUCCEEDED', 'FAILED')),
  error_code text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  input_tokens integer,
  output_tokens integer,
  result jsonb,
  review_status text not null default 'NOT_APPLICABLE'
    check (review_status in ('NOT_APPLICABLE', 'PENDING_REVIEW', 'APPLIED', 'DISCARDED')),
  applied_fields text[] not null default '{}',
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  requested_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'DOCUMENT_EXTRACTION' or document_id is not null or status = 'FAILED'),
  check (status = 'SUCCEEDED' or error_code is not null),
  check (review_status not in ('APPLIED', 'DISCARDED') or (reviewed_by is not null and reviewed_at is not null)),
  check (review_status <> 'APPLIED' or cardinality(applied_fields) > 0)
);
create index ai_runs_claim_idx on public.ai_runs (claim_id, created_at desc);
create index ai_runs_document_idx on public.ai_runs (document_id);

-- The recorded AI output is evidence of what the model proposed; only the
-- review columns may change after insert.
create or replace function public.ai_runs_protect_result() returns trigger
language plpgsql as $$
begin
  if new.kind is distinct from old.kind or new.claim_id is distinct from old.claim_id
     or new.document_id is distinct from old.document_id or new.provider is distinct from old.provider
     or new.model is distinct from old.model or new.status is distinct from old.status
     or new.result is distinct from old.result or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at then
    raise exception 'IMMUTABLE_RECORD: AI run results cannot be modified';
  end if;
  if old.review_status in ('APPLIED', 'DISCARDED') then
    raise exception 'ALREADY_REVIEWED: this AI result has already been reviewed';
  end if;
  return new;
end;
$$;
create trigger ai_runs_protect_result before update on public.ai_runs
  for each row execute function public.ai_runs_protect_result();
create trigger ai_runs_set_updated_at before update on public.ai_runs
  for each row execute function public.set_updated_at();
create trigger ai_runs_no_delete before delete on public.ai_runs
  for each row execute function public.prevent_modification();

-- ---------------------------------------------------------------------------
-- Reminders: internal deadline reminders (sent automatically, deduplicated)
-- and customer reminders (drafts that need a person's approval to send).
-- ---------------------------------------------------------------------------
create table public.claim_reminders (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  reminder_type text not null check (reminder_type in ('DEADLINE_APPROACHING', 'DEADLINE_OVERDUE', 'MISSING_DOCUMENTS')),
  audience text not null check (audience in ('INTERNAL', 'CUSTOMER')),
  recipient_id uuid references public.profiles (id),
  status text not null check (status in ('SENT', 'DRAFT', 'APPROVED', 'DISCARDED')),
  due_at timestamptz,
  title text not null,
  message text not null,
  document_categories text[] not null default '{}',
  notification_id uuid references public.notifications (id) on delete set null,
  information_request_ids uuid[] not null default '{}',
  dedupe_key text unique,
  created_by uuid references public.profiles (id),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- External communication is never sent without a recorded human approval.
  constraint claim_reminders_customer_needs_approval check (
    audience <> 'CUSTOMER' or status in ('DRAFT', 'DISCARDED')
    or (status = 'APPROVED' and decided_by is not null and decided_at is not null)),
  constraint claim_reminders_internal_sent check (audience <> 'INTERNAL' or status = 'SENT'),
  constraint claim_reminders_customer_type check (audience <> 'CUSTOMER' or reminder_type = 'MISSING_DOCUMENTS')
);
create index claim_reminders_claim_idx on public.claim_reminders (claim_id, created_at desc);
create index claim_reminders_status_idx on public.claim_reminders (status, audience);
-- At most one open customer draft per claim.
create unique index claim_reminders_one_open_draft on public.claim_reminders (claim_id)
  where status = 'DRAFT';
create trigger claim_reminders_set_updated_at before update on public.claim_reminders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_any_role(array['CLAIMS_OPERATIONS', 'DOCUMENT_REVIEWER', 'CLAIMS_ADJUSTER',
    'CLAIMS_MANAGER', 'PAYMENT_OPERATIONS', 'COMPLIANCE_OFFICER', 'DATA_ADMIN', 'AUDITOR',
    'CUSTOMER_RECORDS_ADMIN'])
$$;

-- Customer records admins read customer data for record keeping. They are not
-- added to can_access_claim(), so they gain no workflow, notes, tasks,
-- financial or compliance access.
create policy policies_records_read on public.policies for select to authenticated
  using (public.has_role('CUSTOMER_RECORDS_ADMIN'));
create policy claims_records_read on public.claims for select to authenticated
  using (status <> 'DRAFT' and public.has_role('CUSTOMER_RECORDS_ADMIN'));
create policy documents_records_read on public.documents for select to authenticated
  using (public.has_role('CUSTOMER_RECORDS_ADMIN')
    and category not in ('INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE')
    and exists (select 1 from public.claims c where c.id = claim_id and c.status <> 'DRAFT'));

alter table public.ai_runs enable row level security;
alter table public.claim_reminders enable row level security;
grant select on public.ai_runs, public.claim_reminders to authenticated;
revoke all on public.ai_runs, public.claim_reminders from anon;

create policy ai_runs_read on public.ai_runs for select to authenticated
  using (public.has_any_role(array['CLAIMS_OPERATIONS', 'CLAIMS_MANAGER', 'AUDITOR'])
    and public.can_access_claim(claim_id));
create policy claim_reminders_read on public.claim_reminders for select to authenticated
  using (audience = 'INTERNAL' and recipient_id = auth.uid()
    or (public.has_any_role(array['CLAIMS_OPERATIONS', 'CLAIMS_MANAGER', 'AUDITOR'])
        and public.can_access_claim(claim_id)));
