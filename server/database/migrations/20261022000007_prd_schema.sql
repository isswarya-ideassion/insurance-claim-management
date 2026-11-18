-- ===========================================================================
-- PRD alignment (PRD v1.1 sections 2 and 5): forward migration.
--
-- Converts an existing database in place; earlier migrations are unchanged.
--   * Seven PRD roles replace the ten earlier role codes (grants are mapped).
--   * Tables and columns follow the PRD schema: users, evaluations,
--     artifact_requirements, document_versions, payments (settlements merged
--     in), settlement_approval_steps, payees, reviews, policy_snapshots,
--     coverage_results, claim_parties, sla_clocks, segment_config,
--     authority_limits, closure_requests, recoveries, fraud reason codes and
--     flags, integration tables and consents.
--   * audit_logs and ai_runs are partitioned by month; audit_logs is hash-chained.
--   * Bank details and claimant contact details leave plain-text columns. Rows
--     migrated here carry a "plain:" prefix and are encrypted by the API on its
--     next start (field-level encryption key lives only in the API).
--   * Triggers and row-level security are rebuilt for the new model.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Utilities
-- ---------------------------------------------------------------------------
create or replace function public.bump_version() returns trigger
language plpgsql as $$
begin
  new.version := coalesce(old.version, 0) + 1;
  return new;
end;
$$;

create or replace function public.sha256_hex(p text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

create or replace function public.create_monthly_partitions(p_table text, p_from date, p_months integer)
returns void language plpgsql as $$
declare
  m date;
  part text;
begin
  for i in 0 .. p_months - 1 loop
    m := (date_trunc('month', p_from) + make_interval(months => i))::date;
    part := format('%s_y%sm%s', p_table, to_char(m, 'YYYY'), to_char(m, 'MM'));
    if to_regclass('public.' || part) is null then
      begin
        execute format('create table public.%I partition of public.%I for values from (%L) to (%L)',
          part, p_table, m, (m + interval '1 month')::date);
      exception when others then
        -- Rows for this month already sit in the default partition; leave them there.
        raise notice 'partition % not created: %', part, sqlerrm;
      end;
    end if;
  end loop;
end;
$$;

-- Existing triggers stay off while rows are converted; new triggers are
-- created at the end, after the data is in its final shape.
do $$
declare t text;
begin
  foreach t in array array['profiles', 'user_roles', 'policies', 'claims', 'information_requests', 'documents',
    'tasks', 'assessments', 'reserves', 'settlements', 'payments', 'payment_attempts', 'compliance_reviews',
    'notifications', 'ai_runs', 'claim_reminders']
  loop
    execute format('alter table public.%I disable trigger user', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Identity: users, seven roles, ABAC attributes and authority limits
-- ---------------------------------------------------------------------------
alter table public.profiles rename to users;
alter table public.users rename constraint profiles_pkey to users_pkey;
alter index public.profiles_email_key rename to users_email_key;
alter trigger profiles_set_updated_at on public.users rename to users_set_updated_at;
alter table public.users
  add column version integer not null default 1,
  add column updated_by uuid references public.users (id);

insert into public.roles (code, name, description, is_staff) values
  ('CLIENT', 'Client / Policyholder', 'Files claims, uploads artifacts and tracks their own claims', false),
  ('OPS_MANAGER', 'Claim Operation Manager', 'Intake, coverage verification, routing, reserve review, high-value settlement approval, closure and reopening', true),
  ('ADJUSTER', 'Adjuster', 'Investigates assigned claims, evaluates loss, sets reserves within authority and requests closure', true),
  ('DOCUMENT_REVIEWER', 'Document Review Team', 'Validates document completeness and requests missing artifacts', true),
  ('PAYMENT_OPERATOR', 'Payment Operator', 'Approves settlements within limit, verifies payees, issues and reconciles payments', true),
  ('DATA_ENGINEER', 'Data Engineer', 'Operates integration pipelines, source precedence and reconciliation', true),
  ('COMPLIANCE_SECURITY', 'Compliance & Security', 'Compliance reviews, fraud governance, audit, access administration and customer records', true)
on conflict (code) do update
  set name = excluded.name, description = excluded.description, is_staff = excluded.is_staff;

create temporary table tmp_role_map (old_code text primary key, new_code text not null);
insert into tmp_role_map (old_code, new_code) values
  ('CUSTOMER', 'CLIENT'),
  ('CLAIMS_OPERATIONS', 'OPS_MANAGER'),
  ('CLAIMS_MANAGER', 'OPS_MANAGER'),
  ('CLAIMS_ADJUSTER', 'ADJUSTER'),
  ('DOCUMENT_REVIEWER', 'DOCUMENT_REVIEWER'),
  ('PAYMENT_OPERATIONS', 'PAYMENT_OPERATOR'),
  ('DATA_ADMIN', 'DATA_ENGINEER'),
  ('COMPLIANCE_OFFICER', 'COMPLIANCE_SECURITY'),
  ('AUDITOR', 'COMPLIANCE_SECURITY'),
  ('CUSTOMER_RECORDS_ADMIN', 'COMPLIANCE_SECURITY');

create table public.user_attributes (
  user_id uuid primary key references public.users (id) on delete cascade,
  reserve_limit numeric(14, 2) check (reserve_limit is null or reserve_limit >= 0),
  settlement_limit numeric(14, 2) check (settlement_limit is null or settlement_limit >= 0),
  currency char(3) not null default 'USD',
  region text,
  team_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id),
  version integer not null default 1
);

-- A claims manager's single approval limit becomes both their reserve and settlement limit.
insert into public.user_attributes (user_id, reserve_limit, settlement_limit)
select user_id, approval_limit, approval_limit
from public.user_roles
where role_code = 'CLAIMS_MANAGER' and approval_limit is not null
on conflict (user_id) do nothing;

insert into public.user_roles (user_id, role_code, granted_by, granted_at)
select distinct on (ur.user_id, m.new_code) ur.user_id, m.new_code, ur.granted_by, ur.granted_at
from public.user_roles ur
join tmp_role_map m on m.old_code = ur.role_code
where m.old_code <> m.new_code
order by ur.user_id, m.new_code, ur.granted_at
on conflict (user_id, role_code) do nothing;

delete from public.user_roles where role_code in (select old_code from tmp_role_map where old_code <> new_code);
update public.tasks t set assigned_role = m.new_code
from tmp_role_map m where t.assigned_role = m.old_code and m.old_code <> m.new_code;
delete from public.roles where code in (select old_code from tmp_role_map where old_code <> new_code);
alter table public.user_roles drop column approval_limit;

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, email, full_name, phone)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;

  if coalesce(new.raw_app_meta_data ->> 'provisioned_staff', 'false') <> 'true' then
    insert into public.user_roles (user_id, role_code)
    values (new.id, 'CLIENT')
    on conflict (user_id, role_code) do nothing;
  end if;
  return new;
end;
$$;

create table public.authority_limits (
  id uuid primary key default gen_random_uuid(),
  role text not null references public.roles (code),
  segment text not null check (segment in ('PERSONAL', 'COMMERCIAL')),
  coverage_line text not null default '*',
  limit_type text not null check (limit_type in ('RESERVE', 'SETTLEMENT')),
  max_amount numeric(14, 2) not null check (max_amount > 0),
  currency char(3) not null default 'USD',
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_by uuid references public.users (id),
  approved_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (created_by is null or approved_by is null or created_by <> approved_by)
);
create unique index authority_limits_current on public.authority_limits (role, segment, coverage_line, limit_type)
  where effective_to is null;

insert into public.authority_limits (role, segment, coverage_line, limit_type, max_amount, effective_from) values
  ('ADJUSTER', 'PERSONAL', '*', 'RESERVE', 15000, '2026-01-01'),
  ('ADJUSTER', 'COMMERCIAL', '*', 'RESERVE', 30000, '2026-01-01'),
  ('OPS_MANAGER', 'PERSONAL', '*', 'RESERVE', 250000, '2026-01-01'),
  ('OPS_MANAGER', 'COMMERCIAL', '*', 'RESERVE', 1000000, '2026-01-01'),
  ('PAYMENT_OPERATOR', 'PERSONAL', '*', 'SETTLEMENT', 10000, '2026-01-01'),
  ('PAYMENT_OPERATOR', 'COMMERCIAL', '*', 'SETTLEMENT', 25000, '2026-01-01'),
  ('OPS_MANAGER', 'PERSONAL', '*', 'SETTLEMENT', 250000, '2026-01-01'),
  ('OPS_MANAGER', 'COMMERCIAL', '*', 'SETTLEMENT', 1000000, '2026-01-01');

-- Effective monetary authority: a per-user override, else the highest limit of
-- any role the user holds for the segment and coverage line.
create or replace function public.effective_limit(p_user uuid, p_limit_type text, p_segment text, p_coverage_line text default '*')
returns numeric language sql stable as $$
  select coalesce(
    (select case when p_limit_type = 'RESERVE' then ua.reserve_limit else ua.settlement_limit end
       from public.user_attributes ua where ua.user_id = p_user),
    (select max(al.max_amount)
       from public.authority_limits al
       join public.user_roles ur on ur.role_code = al.role and ur.user_id = p_user
      where al.limit_type = p_limit_type
        and al.segment = coalesce(p_segment, 'PERSONAL')
        and al.coverage_line in ('*', coalesce(p_coverage_line, '*'))
        and al.effective_from <= now()
        and (al.effective_to is null or al.effective_to > now())))
$$;

-- ---------------------------------------------------------------------------
-- 2. Configuration by segment (versioned, four-eyes approved)
-- ---------------------------------------------------------------------------
create table public.segment_config (
  id uuid primary key default gen_random_uuid(),
  segment text not null check (segment in ('PERSONAL', 'COMMERCIAL')),
  config_key text not null,
  config_value jsonb not null,
  version integer not null default 1,
  status text not null default 'PROPOSED' check (status in ('PROPOSED', 'ACTIVE', 'RETIRED', 'REJECTED')),
  effective_from timestamptz,
  effective_to timestamptz,
  notes text,
  proposed_by uuid references public.users (id),
  proposed_at timestamptz not null default now(),
  approved_by uuid references public.users (id),
  approved_at timestamptz,
  unique (segment, config_key, version),
  -- Seeded system configuration has no proposer; any human change needs a different approver.
  check (status <> 'ACTIVE' or proposed_by is null or (approved_by is not null and approved_by <> proposed_by)),
  check (status <> 'ACTIVE' or effective_from is not null)
);
create unique index segment_config_one_active on public.segment_config (segment, config_key) where status = 'ACTIVE';

insert into public.segment_config (segment, config_key, config_value, status, effective_from, notes) values
  ('PERSONAL', 'required_artifacts', '{"MOTOR":["PROOF_OF_LOSS","PHOTOS","REPAIR_ESTIMATE"],"PROPERTY":["PROOF_OF_LOSS","PHOTOS"],"HEALTH":["MEDICAL_REPORT","INVOICE"],"TRAVEL":["PROOF_OF_LOSS","INVOICE"],"LIABILITY":["PROOF_OF_LOSS"]}', 'ACTIVE', '2026-01-01', 'Initial configuration'),
  ('COMMERCIAL', 'required_artifacts', '{"MOTOR":["PROOF_OF_LOSS","PHOTOS","REPAIR_ESTIMATE"],"PROPERTY":["PROOF_OF_LOSS","PHOTOS"],"HEALTH":["MEDICAL_REPORT","INVOICE"],"TRAVEL":["PROOF_OF_LOSS","INVOICE"],"LIABILITY":["PROOF_OF_LOSS"]}', 'ACTIVE', '2026-01-01', 'Initial configuration'),
  ('PERSONAL', 'sla_hours', '{"SUBMITTED":24,"POLICY_VERIFICATION":48,"DOCUMENTS_REQUIRED":336,"DOCUMENT_REVIEW":48,"ADJUSTER_ASSIGNMENT":24,"INVESTIGATION":240,"RESERVE_APPROVAL":24,"COMPLIANCE_REVIEW":72,"SETTLEMENT_APPROVAL":48,"PAYMENT_PENDING":48,"PAYMENT_FAILED":24,"PAID":120,"REOPENED":48}', 'ACTIVE', '2026-01-01', 'PRD v1.1 section 3.10'),
  ('COMMERCIAL', 'sla_hours', '{"SUBMITTED":24,"POLICY_VERIFICATION":72,"DOCUMENTS_REQUIRED":504,"DOCUMENT_REVIEW":48,"ADJUSTER_ASSIGNMENT":24,"INVESTIGATION":480,"RESERVE_APPROVAL":48,"COMPLIANCE_REVIEW":120,"SETTLEMENT_APPROVAL":72,"PAYMENT_PENDING":48,"PAYMENT_FAILED":24,"PAID":240,"REOPENED":48}', 'ACTIVE', '2026-01-01', 'PRD v1.1 section 3.10'),
  ('PERSONAL', 'severity_thresholds', '{"MEDIUM":5000,"HIGH":50000,"CATASTROPHIC":200000}', 'ACTIVE', '2026-01-01', 'Severity by estimated loss'),
  ('COMMERCIAL', 'severity_thresholds', '{"MEDIUM":25000,"HIGH":250000,"CATASTROPHIC":1000000}', 'ACTIVE', '2026-01-01', 'Severity by estimated loss'),
  ('PERSONAL', 'fraud_review_threshold', '60', 'ACTIVE', '2026-01-01', 'Fraud score that routes a claim to compliance review'),
  ('COMMERCIAL', 'fraud_review_threshold', '60', 'ACTIVE', '2026-01-01', 'Fraud score that routes a claim to compliance review'),
  ('PERSONAL', 'unclaimed_task_escalation_hours', '12', 'ACTIVE', '2026-01-01', 'Queue tasks without a named owner escalate after this wait'),
  ('COMMERCIAL', 'unclaimed_task_escalation_hours', '24', 'ACTIVE', '2026-01-01', 'Queue tasks without a named owner escalate after this wait');

-- ---------------------------------------------------------------------------
-- 3. Policies and payees
-- ---------------------------------------------------------------------------
alter table public.policies rename column policy_number to external_policy_no;
alter table public.policies rename column holder_id to insured_id;
alter table public.policies rename column effective_from to effective_date;
alter table public.policies rename column effective_to to expiry_date;
alter table public.policies rename constraint policies_policy_number_key to policies_external_policy_no_key;
alter table public.policies rename constraint policies_holder_id_fkey to policies_insured_id_fkey;
alter index public.policies_holder_idx rename to policies_insured_idx;
alter table public.policies
  add column segment text not null default 'PERSONAL' check (segment in ('PERSONAL', 'COMMERCIAL')),
  add column coverages jsonb not null default '[]'::jsonb,
  add column limits jsonb not null default '{}'::jsonb,
  add column deductibles jsonb not null default '{}'::jsonb,
  add column exclusions jsonb not null default '[]'::jsonb,
  add column payee_id uuid,
  add column source_system text not null default 'HUB',
  add column source_synced_at timestamptz,
  add column version integer not null default 1,
  add column created_by uuid references public.users (id),
  add column updated_by uuid references public.users (id);

update public.policies set
  segment = case when policy_type = 'LIABILITY' then 'COMMERCIAL' else 'PERSONAL' end,
  limits = jsonb_build_object('sum_insured', sum_insured),
  deductibles = jsonb_build_object('per_claim', deductible),
  coverages = (case policy_type
    when 'MOTOR' then '["OWN_DAMAGE","THIRD_PARTY_LIABILITY"]'
    when 'PROPERTY' then '["BUILDING","CONTENTS"]'
    when 'HEALTH' then '["MEDICAL"]'
    when 'TRAVEL' then '["TRAVEL"]'
    else '["LIABILITY"]' end)::jsonb;

create table public.payees (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.users (id),
  name text not null,
  payee_type text not null default 'INDIVIDUAL' check (payee_type in ('INDIVIDUAL', 'BUSINESS')),
  bank_name text,
  -- AES-256-GCM ciphertext written by the API ("v1:..."); "plain:" marks migrated rows awaiting encryption.
  bank_details_encrypted text,
  bank_last4 text,
  -- Keyed HMAC of the account number for duplicate detection without decryption.
  bank_details_hash text,
  bank_details_changed_at timestamptz,
  bank_details_changed_by uuid references public.users (id),
  verification_status text not null default 'UNVERIFIED' check (verification_status in ('UNVERIFIED', 'VERIFIED', 'FAILED')),
  verified_by uuid references public.users (id),
  verified_at timestamptz,
  verification_notes text,
  sanctions_checked_at timestamptz,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users (id),
  version integer not null default 1,
  check (verification_status <> 'VERIFIED' or verified_at is not null),
  -- Four eyes on bank details: whoever changed them cannot verify them.
  check (verified_by is null or bank_details_changed_by is null or verified_by <> bank_details_changed_by)
);
create index payees_customer_idx on public.payees (customer_id);
create index payees_hash_idx on public.payees (bank_details_hash);

insert into public.payees (customer_id, name, bank_name, bank_details_encrypted, bank_last4,
  verification_status, verified_at, verification_notes)
select distinct on (p.insured_id, p.payout_account_number)
  p.insured_id, p.insured_name, p.payout_bank_name, 'plain:' || p.payout_account_number,
  right(p.payout_account_number, 4), 'VERIFIED', now(), 'Migrated from policy payout details'
from public.policies p
where p.payout_account_number is not null
order by p.insured_id, p.payout_account_number, p.created_at;

update public.policies p set payee_id = y.id
from public.payees y
where y.customer_id = p.insured_id and y.bank_details_encrypted = 'plain:' || p.payout_account_number;

alter table public.policies add constraint policies_payee_id_fkey foreign key (payee_id) references public.payees (id);
alter table public.policies drop column payout_bank_name, drop column payout_account_number;

-- ---------------------------------------------------------------------------
-- 4. Claims, lifecycle stage, claim parties, snapshots and coverage results
-- ---------------------------------------------------------------------------
create or replace function public.claim_stage(p_status text, p_hold_from text) returns text
language sql immutable as $$
  select case coalesce(nullif(p_status, 'ON_HOLD'), p_hold_from, 'SUBMITTED')
    when 'DRAFT' then 'FNOL'
    when 'SUBMITTED' then 'FNOL'
    when 'POLICY_VERIFICATION' then 'COVERAGE_VERIFICATION'
    when 'DOCUMENTS_REQUIRED' then 'INVESTIGATION'
    when 'DOCUMENT_REVIEW' then 'INVESTIGATION'
    when 'ADJUSTER_ASSIGNMENT' then 'TRIAGE'
    when 'INVESTIGATION' then 'INVESTIGATION'
    when 'RESERVE_APPROVAL' then 'RESERVE'
    when 'COMPLIANCE_REVIEW' then 'EVALUATION'
    when 'SETTLEMENT_APPROVAL' then 'SETTLEMENT'
    when 'PAYMENT_PENDING' then 'PAYMENT'
    when 'PAYMENT_FAILED' then 'PAYMENT'
    when 'PAID' then 'PAYMENT'
    when 'REJECTED' then 'EVALUATION'
    else 'CLOSURE' end
$$;

alter table public.claims rename column incident_at to loss_date;
alter table public.claims rename column incident_location to loss_location;
alter table public.claims rename column incident_category to loss_type;
alter table public.claims rename column incident_description to loss_description;
alter table public.claims rename column submitted_at to opened_at;
alter index public.claims_submitted_idx rename to claims_opened_idx;
alter table public.claims
  add column stage text,
  add column segment text not null default 'PERSONAL' check (segment in ('PERSONAL', 'COMMERCIAL')),
  add column severity text check (severity is null or severity in ('LOW', 'MEDIUM', 'HIGH', 'CATASTROPHIC')),
  add column complexity smallint check (complexity is null or complexity between 1 and 4),
  add column fraud_score smallint check (fraud_score is null or fraud_score between 0 and 100),
  add column coverage_result text check (coverage_result is null or coverage_result in ('COVERED', 'NOT_COVERED', 'NEEDS_REVIEW')),
  add column policy_snapshot_id uuid,
  add column reopen_count integer not null default 0 check (reopen_count >= 0),
  add column version integer not null default 1,
  add column updated_by uuid references public.users (id);

update public.claims c set
  stage = public.claim_stage(c.status, c.hold_from_status),
  segment = coalesce((select p.segment from public.policies p where p.id = c.policy_id), 'PERSONAL'),
  coverage_result = case c.policy_verified when true then 'COVERED' when false then 'NOT_COVERED' end,
  severity = case
    when c.status = 'DRAFT' or c.estimated_loss is null then null
    when c.estimated_loss < 5000 then 'LOW'
    when c.estimated_loss < 50000 then 'MEDIUM'
    when c.estimated_loss < 200000 then 'HIGH'
    else 'CATASTROPHIC' end,
  reopen_count = (select count(*) from public.claim_status_history h where h.claim_id = c.id and h.to_status = 'REOPENED');
alter table public.claims alter column stage set not null;
create index claims_stage_idx on public.claims (stage);
create index claims_reviewer_idx on public.claims (assigned_reviewer_id);

create table public.claim_parties (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  party_type text not null check (party_type in ('CLAIMANT', 'INSURED', 'WITNESS', 'THIRD_PARTY')),
  name text,
  -- AES-256-GCM ciphertext of {"email","phone"} written by the API; "plain:" marks migrated rows.
  contact_encrypted text,
  role_in_loss text,
  represented_by text,
  is_payee_candidate boolean not null default false,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index claim_parties_claim_idx on public.claim_parties (claim_id);
create unique index claim_parties_one_claimant on public.claim_parties (claim_id) where party_type = 'CLAIMANT';

insert into public.claim_parties (claim_id, party_type, name, contact_encrypted, role_in_loss, is_payee_candidate, created_by, created_at)
select c.id, 'CLAIMANT', c.contact_name,
  case when c.contact_phone is not null or c.contact_email is not null
    then 'plain:' || jsonb_build_object('email', c.contact_email, 'phone', c.contact_phone)::text end,
  'Claimant', true, c.created_by, c.created_at
from public.claims c
where c.contact_name is not null or c.contact_phone is not null or c.contact_email is not null;
alter table public.claims drop column contact_name, drop column contact_phone, drop column contact_email;

create table public.policy_snapshots (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  policy_id uuid not null references public.policies (id),
  policy_version integer not null,
  snapshot jsonb not null,
  sha256 text not null,
  reason text not null default 'FNOL',
  captured_by uuid references public.users (id),
  captured_at timestamptz not null default now()
);
create index policy_snapshots_claim_idx on public.policy_snapshots (claim_id, captured_at desc);

insert into public.policy_snapshots (claim_id, policy_id, policy_version, snapshot, sha256, reason, captured_at)
select c.id, p.id, p.version, to_jsonb(p) - 'payee_id', public.sha256_hex((to_jsonb(p) - 'payee_id')::text),
  'MIGRATION_BACKFILL', coalesce(c.opened_at, c.created_at)
from public.claims c join public.policies p on p.id = c.policy_id
where c.status <> 'DRAFT';
update public.claims c set policy_snapshot_id = s.id from public.policy_snapshots s where s.claim_id = c.id;
alter table public.claims add constraint claims_policy_snapshot_id_fkey
  foreign key (policy_snapshot_id) references public.policy_snapshots (id);

create table public.coverage_results (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  snapshot_id uuid references public.policy_snapshots (id),
  result text not null check (result in ('COVERED', 'NOT_COVERED', 'NEEDS_REVIEW')),
  matched_perils jsonb not null default '[]'::jsonb,
  applied_limits jsonb not null default '{}'::jsonb,
  deductible numeric(14, 2),
  clause_refs text[] not null default '{}',
  checks jsonb not null default '{}'::jsonb,
  notes text,
  ai_run_ref uuid,
  reviewed_by uuid references public.users (id),
  created_at timestamptz not null default now()
);
create index coverage_results_claim_idx on public.coverage_results (claim_id, created_at desc);

insert into public.coverage_results (claim_id, snapshot_id, result, matched_perils, applied_limits, deductible, notes, reviewed_by, created_at)
select c.id, c.policy_snapshot_id,
  case when c.policy_verified then 'COVERED' else 'NOT_COVERED' end,
  case when c.loss_type is not null then jsonb_build_array(c.loss_type) else '[]'::jsonb end,
  coalesce(p.limits, '{}'::jsonb), p.deductible, c.policy_verification_notes, c.policy_verified_by,
  coalesce(c.policy_verified_at, now())
from public.claims c left join public.policies p on p.id = c.policy_id
where c.policy_verified is not null;
alter table public.claims
  drop column policy_verified,
  drop column policy_verified_by,
  drop column policy_verified_at,
  drop column policy_verification_notes;

-- ---------------------------------------------------------------------------
-- 5. Documents: one row per document, every file version in document_versions
-- ---------------------------------------------------------------------------
create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  version_no integer not null check (version_no >= 1),
  storage_key text not null unique,
  file_name text not null,
  mime_type text not null,
  size_bytes integer not null check (size_bytes > 0),
  sha256 text,
  status text not null check (status in ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  uploaded_by uuid not null references public.users (id),
  uploaded_at timestamptz not null default now(),
  reviewed_by uuid references public.users (id),
  reviewed_at timestamptz,
  rejection_reason text,
  change_reason text,
  created_at timestamptz not null default now(),
  unique (document_id, version_no)
);

create temporary table tmp_doc_latest as
  select distinct on (document_group_id) document_group_id, id as latest_id
  from public.documents
  order by document_group_id, version_no desc;

insert into public.document_versions (document_id, version_no, storage_key, file_name, mime_type, size_bytes, sha256,
  status, uploaded_by, uploaded_at, reviewed_by, reviewed_at, rejection_reason, created_at)
select l.latest_id, d.version_no, d.storage_path, d.file_name, d.mime_type, d.size_bytes, d.checksum_sha256,
  d.status, d.uploaded_by, d.uploaded_at, d.reviewed_by, d.reviewed_at, d.rejection_reason, d.created_at
from public.documents d join tmp_doc_latest l using (document_group_id);

-- ---------------------------------------------------------------------------
-- 6. AI runs: PRD columns, partitioned by month (rebuilt before older document
--    versions are removed so their references can be remapped)
-- ---------------------------------------------------------------------------
alter table public.ai_runs rename to ai_runs_legacy;
alter table public.ai_runs_legacy rename constraint ai_runs_pkey to ai_runs_legacy_pkey;
drop index public.ai_runs_claim_idx;
drop index public.ai_runs_document_idx;

create table public.ai_runs (
  id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent text not null,
  prompt_version text not null default 'v1',
  claim_id uuid not null references public.claims (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  provider text not null,
  model text not null,
  status text not null check (status in ('SUCCEEDED', 'FAILED')),
  error_code text,
  input_hash text,
  output jsonb,
  confidence numeric(4, 3) check (confidence is null or confidence between 0 and 1),
  needs_human boolean not null default true,
  human_decision text not null default 'NOT_REQUIRED' check (human_decision in ('PENDING', 'ACCEPTED', 'REJECTED', 'NOT_REQUIRED')),
  applied_fields text[] not null default '{}',
  decided_by uuid references public.users (id),
  decided_at timestamptz,
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  input_tokens integer,
  output_tokens integer,
  requested_by uuid not null references public.users (id),
  updated_at timestamptz not null default now(),
  primary key (id, created_at),
  check (agent <> 'intake-parser' or document_id is not null or status = 'FAILED'),
  check (status = 'SUCCEEDED' or error_code is not null),
  check (human_decision not in ('ACCEPTED', 'REJECTED') or (decided_by is not null and decided_at is not null)),
  check (human_decision <> 'ACCEPTED' or agent <> 'intake-parser' or cardinality(applied_fields) > 0)
) partition by range (created_at);
create table public.ai_runs_default partition of public.ai_runs default;
select public.create_monthly_partitions('ai_runs', date '2026-01-01', 24);
create index ai_runs_claim_idx on public.ai_runs (claim_id, created_at desc);
create index ai_runs_document_idx on public.ai_runs (document_id);
create index ai_runs_agent_idx on public.ai_runs (agent, created_at desc);

insert into public.ai_runs (id, created_at, agent, prompt_version, claim_id, document_id, provider, model, status,
  error_code, output, needs_human, human_decision, applied_fields, decided_by, decided_at, latency_ms,
  input_tokens, output_tokens, requested_by, updated_at)
select a.id, a.created_at,
  case a.kind when 'DOCUMENT_EXTRACTION' then 'intake-parser' else 'claim-summarizer' end,
  'v1', a.claim_id,
  coalesce((select l.latest_id from public.documents d join tmp_doc_latest l using (document_group_id) where d.id = a.document_id), a.document_id),
  a.provider, a.model, a.status, a.error_code, a.result,
  a.kind = 'DOCUMENT_EXTRACTION',
  case a.review_status when 'PENDING_REVIEW' then 'PENDING' when 'APPLIED' then 'ACCEPTED' when 'DISCARDED' then 'REJECTED' else 'NOT_REQUIRED' end,
  a.applied_fields, a.reviewed_by, a.reviewed_at, a.duration_ms, a.input_tokens, a.output_tokens, a.requested_by, a.updated_at
from public.ai_runs_legacy a
order by a.created_at;
drop table public.ai_runs_legacy;

-- Older document versions now live only in document_versions.
delete from public.documents d using tmp_doc_latest l
where d.document_group_id = l.document_group_id and d.id <> l.latest_id;

alter table public.document_versions add constraint document_versions_document_id_fkey
  foreign key (document_id) references public.documents (id) on delete cascade;
create index document_versions_document_idx on public.document_versions (document_id, version_no desc);

alter table public.documents rename column category to doc_type;
alter table public.documents rename column storage_path to storage_key;
alter table public.documents rename column version_no to version;
alter table public.documents rename column checksum_sha256 to sha256;
alter table public.documents rename column uploaded_at to received_at;
alter table public.documents rename constraint documents_storage_path_key to documents_storage_key_key;
alter table public.documents drop column document_group_id;
alter table public.documents drop constraint documents_status_check;
alter table public.documents add constraint documents_status_check check (status in ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED'));
alter table public.documents
  add column source text not null default 'WEB' check (source in ('WEB', 'PWA', 'EMAIL', 'DMS', 'STAFF')),
  add column ocr_text_ref text,
  add column extracted_fields jsonb not null default '{}'::jsonb;
update public.documents d set source = 'STAFF'
where not exists (select 1 from public.user_roles ur where ur.user_id = d.uploaded_by and ur.role_code = 'CLIENT');
create index documents_type_idx on public.documents (claim_id, doc_type);

-- ---------------------------------------------------------------------------
-- 7. Artifact requirements (formerly information requests) with one tracked
--    row per required artifact of each claim
-- ---------------------------------------------------------------------------
alter table public.information_requests rename to artifact_requirements;
alter table public.artifact_requirements rename constraint information_requests_pkey to artifact_requirements_pkey;
alter index public.information_requests_claim_idx rename to artifact_requirements_claim_idx;
alter trigger information_requests_set_updated_at on public.artifact_requirements rename to artifact_requirements_set_updated_at;
alter table public.artifact_requirements rename column request_type to requirement_type;
alter table public.artifact_requirements rename column document_category to doc_type;
alter table public.artifact_requirements rename column message to request_message;
alter table public.artifact_requirements rename column responded_at to received_at;
alter table public.artifact_requirements drop constraint information_requests_status_check;
alter table public.artifact_requirements drop constraint information_requests_request_type_check;
alter table public.artifact_requirements alter column request_message drop not null;
alter table public.artifact_requirements alter column requested_by drop not null;
alter table public.artifact_requirements
  add column requested_at timestamptz,
  add column is_required boolean not null default false,
  add column document_id uuid references public.documents (id) on delete set null,
  add column waived_reason text,
  add column version integer not null default 1;
update public.artifact_requirements set
  status = case status when 'OPEN' then 'REQUESTED' when 'RESPONDED' then 'RECEIVED' else status end,
  requested_at = created_at;

alter table public.documents rename column information_request_id to artifact_requirement_id;
alter table public.documents rename constraint documents_information_request_id_fkey to documents_artifact_requirement_id_fkey;

create temporary table tmp_required (claim_type text, doc_type text);
insert into tmp_required (claim_type, doc_type) values
  ('MOTOR', 'PROOF_OF_LOSS'), ('MOTOR', 'PHOTOS'), ('MOTOR', 'REPAIR_ESTIMATE'),
  ('PROPERTY', 'PROOF_OF_LOSS'), ('PROPERTY', 'PHOTOS'),
  ('HEALTH', 'MEDICAL_REPORT'), ('HEALTH', 'INVOICE'),
  ('TRAVEL', 'PROOF_OF_LOSS'), ('TRAVEL', 'INVOICE'),
  ('LIABILITY', 'PROOF_OF_LOSS');

create temporary table tmp_req_docs as
  select c.id as claim_id, r.doc_type,
    (select d.id from public.documents d
      where d.claim_id = c.id and d.doc_type = r.doc_type
      order by case d.status when 'ACCEPTED' then 0 when 'PENDING_REVIEW' then 1 else 2 end, d.received_at desc
      limit 1) as document_id
  from public.claims c join tmp_required r on r.claim_type = c.claim_type
  where c.status not in ('DRAFT', 'WITHDRAWN');

update public.artifact_requirements a set is_required = true
from (
  select distinct on (a2.claim_id, a2.doc_type) a2.id
  from public.artifact_requirements a2
  join tmp_req_docs t on t.claim_id = a2.claim_id and t.doc_type = a2.doc_type
  where a2.requirement_type = 'DOCUMENT'
  order by a2.claim_id, a2.doc_type, a2.created_at desc
) latest
where a.id = latest.id;

insert into public.artifact_requirements (claim_id, requirement_type, doc_type, is_required, status, created_at, updated_at)
select t.claim_id, 'DOCUMENT', t.doc_type, true, 'MISSING', now(), now()
from tmp_req_docs t
where not exists (
  select 1 from public.artifact_requirements a
  where a.claim_id = t.claim_id and a.doc_type = t.doc_type and a.is_required);

update public.artifact_requirements a set
  document_id = t.document_id,
  status = case
    when d.status = 'ACCEPTED' then 'ACCEPTED'
    when a.status = 'REQUESTED' then 'REQUESTED'
    when d.status = 'PENDING_REVIEW' then 'RECEIVED'
    when d.status = 'REJECTED' then 'REJECTED'
    when a.status in ('CLOSED', 'CANCELLED') then 'MISSING'
    else a.status end
from tmp_req_docs t
left join public.documents d on d.id = t.document_id
where a.is_required and a.claim_id = t.claim_id and a.doc_type = t.doc_type;

update public.artifact_requirements a set status = 'WAIVED', waived_reason = c.document_exception_reason
from public.claims c
where a.claim_id = c.id and a.is_required and c.document_exception_at is not null and a.status <> 'ACCEPTED';

alter table public.artifact_requirements
  add constraint artifact_requirements_status_check
    check (status in ('MISSING', 'REQUESTED', 'RECEIVED', 'ACCEPTED', 'REJECTED', 'WAIVED', 'CLOSED', 'CANCELLED')),
  add constraint artifact_requirements_type_check check (requirement_type in ('DOCUMENT', 'INFORMATION')),
  add constraint artifact_requirements_doc_type_check check (requirement_type = 'INFORMATION' or doc_type is not null),
  add constraint artifact_requirements_waiver_check check (status <> 'WAIVED' or waived_reason is not null),
  add constraint artifact_requirements_message_check check (status <> 'REQUESTED' or request_message is not null);
create unique index artifact_requirements_one_required on public.artifact_requirements (claim_id, doc_type) where is_required;

-- ---------------------------------------------------------------------------
-- 8. Tasks
-- ---------------------------------------------------------------------------
alter table public.tasks rename column task_type to type;
alter table public.tasks rename column assignee_id to owner_user_id;
alter table public.tasks rename column assigned_role to owner_role;
alter table public.tasks rename column is_mandatory to blocking;
alter index public.tasks_assignee_idx rename to tasks_owner_idx;
alter table public.tasks
  add column source_stage text,
  add column claimed_at timestamptz,
  add column escalated_at timestamptz,
  add column version integer not null default 1;
update public.tasks t set source_stage = c.stage from public.claims c where c.id = t.claim_id;
update public.tasks set claimed_at = coalesce(updated_at, created_at) where owner_user_id is not null;
create index tasks_role_queue_idx on public.tasks (owner_role, status) where owner_user_id is null;

create table public.task_sources (
  task_id uuid not null unique references public.tasks (id) on delete cascade,
  source_system text not null,
  external_ref text not null,
  external_status text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  sync_state text not null default 'SYNCED' check (sync_state in ('SYNCED', 'PENDING_WRITEBACK', 'FAILED', 'CLOSED')),
  primary key (source_system, external_ref)
);

-- ---------------------------------------------------------------------------
-- 9. Evaluations (formerly assessments)
-- ---------------------------------------------------------------------------
alter table public.assessments rename to evaluations;
alter table public.evaluations rename constraint assessments_pkey to evaluations_pkey;
alter table public.evaluations rename constraint assessments_claim_id_version_no_key to evaluations_claim_id_version_no_key;
alter trigger assessments_set_updated_at on public.evaluations rename to evaluations_set_updated_at;
alter table public.evaluations rename column estimated_loss to loss_value;
alter table public.evaluations rename column recommendation to decision;
alter table public.evaluations
  add column liability_pct numeric(5, 2) check (liability_pct is null or liability_pct between 0 and 100),
  add column denial_letter_doc_id uuid references public.documents (id) on delete set null;
create index evaluations_claim_idx on public.evaluations (claim_id, version_no desc);

-- ---------------------------------------------------------------------------
-- 10. Reverse-review checkpoints, fraud taxonomy and claim fraud flags
-- ---------------------------------------------------------------------------
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  checkpoint_type text not null check (checkpoint_type in ('COMPLIANCE', 'RESERVE', 'EVALUATION', 'CLOSURE')),
  subject_type text,
  subject_id uuid,
  status text not null,
  outcome text check (outcome is null or outcome in ('APPROVED', 'MODIFIED', 'REJECTED', 'RETURNED')),
  amount numeric(14, 2),
  approver_limit numeric(14, 2),
  requested_by uuid references public.users (id),
  reviewer_id uuid references public.users (id),
  decided_by uuid references public.users (id),
  comments text,
  escalation_notes text,
  exception_reason text,
  checklist jsonb not null default '{}'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  hold_active boolean not null default false,
  hold_placed_by uuid references public.users (id),
  hold_placed_at timestamptz,
  reviewed_at timestamptz,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint reviews_compliance_status check (checkpoint_type <> 'COMPLIANCE'
    or status in ('PENDING', 'IN_REVIEW', 'CLEARED', 'HOLD', 'EXCEPTION_APPROVED', 'ESCALATED')),
  constraint reviews_decision_complete check (checkpoint_type = 'COMPLIANCE'
    or (status = 'DECIDED' and outcome is not null and decided_by is not null and reviewed_at is not null)),
  constraint reviews_exception_reason check (status <> 'EXCEPTION_APPROVED' or exception_reason is not null),
  constraint reviews_hold check (not hold_active or status in ('HOLD', 'ESCALATED')),
  constraint reviews_no_self_review check (requested_by is null or decided_by is null or requested_by <> decided_by),
  constraint reviews_within_limit check (checkpoint_type <> 'RESERVE' or outcome not in ('APPROVED', 'MODIFIED')
    or (approver_limit is not null and amount <= approver_limit))
);
create index reviews_claim_idx on public.reviews (claim_id, created_at desc);
create index reviews_open_compliance_idx on public.reviews (status) where checkpoint_type = 'COMPLIANCE';
create index reviews_active_hold_idx on public.reviews (claim_id) where hold_active;
create index reviews_subject_idx on public.reviews (subject_id);

insert into public.reviews (id, claim_id, checkpoint_type, subject_type, subject_id, status, reviewer_id, decided_by,
  comments, escalation_notes, exception_reason, checklist, evidence, hold_active, hold_placed_by, hold_placed_at,
  reviewed_at, created_by, created_at, updated_at)
select id, claim_id, 'COMPLIANCE', 'claim', claim_id, status, reviewer_id, decided_by,
  decision_notes, escalation_notes, exception_reason, checklist, evidence, hold_active, hold_placed_by, hold_placed_at,
  decided_at, created_by, created_at, updated_at
from public.compliance_reviews;

insert into public.reviews (claim_id, checkpoint_type, subject_type, subject_id, status, outcome, amount, approver_limit,
  requested_by, decided_by, reviewer_id, comments, reviewed_at, created_at, updated_at)
select claim_id, 'RESERVE', 'reserve', reserve_id, 'DECIDED', decision, amount, approver_limit,
  requested_by, decided_by, decided_by, comments, decided_at, created_at, created_at
from public.approvals
where approval_type = 'RESERVE';

create table public.fraud_reason_codes (
  code text primary key,
  description text not null,
  category text not null,
  weight smallint not null check (weight between 0 and 100),
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now()
);
insert into public.fraud_reason_codes (code, description, category, weight) values
  ('SANCTIONS_MATCH', 'Party or payee matches a sanctions list entry', 'SCREENING', 60),
  ('PEP_MATCH', 'Party is a politically exposed person', 'SCREENING', 40),
  ('FRAUD_INDICATOR', 'Known fraud indicator present in the file', 'BEHAVIOUR', 50),
  ('LATE_NOTIFICATION', 'Loss reported long after it occurred', 'TIMING', 15),
  ('HIGH_VALUE', 'Claimed amount is unusually high for the loss type', 'AMOUNT', 10),
  ('DUPLICATE_SUSPECTED', 'Possible duplicate of another claim', 'PATTERN', 35),
  ('INCONSISTENT_STATEMENTS', 'Statements or documents contradict each other', 'EVIDENCE', 30),
  ('OTHER', 'Other reason recorded by a reviewer', 'OTHER', 10);

create table public.claim_fraud_flags (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  code text not null references public.fraud_reason_codes (code),
  severity text not null default 'MEDIUM' check (severity in ('LOW', 'MEDIUM', 'HIGH')),
  contribution smallint not null check (contribution between 0 and 100),
  note text,
  resolved boolean not null default false,
  resolved_by uuid references public.users (id),
  resolved_at timestamptz,
  review_id uuid references public.reviews (id) on delete set null,
  ai_run_ref uuid,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index claim_fraud_flags_claim_idx on public.claim_fraud_flags (claim_id) where not resolved;

insert into public.claim_fraud_flags (claim_id, code, severity, contribution, note, resolved, review_id, created_by, created_at)
select r.claim_id, f ->> 'code', coalesce(f ->> 'severity', 'MEDIUM'),
  round(frc.weight * case coalesce(f ->> 'severity', 'MEDIUM') when 'HIGH' then 1.0 when 'MEDIUM' then 0.6 else 0.3 end),
  f ->> 'note', coalesce((f ->> 'resolved')::boolean, false), r.id, r.created_by, r.created_at
from public.compliance_reviews r
cross join lateral jsonb_array_elements(r.risk_flags) f
join public.fraud_reason_codes frc on frc.code = f ->> 'code';

update public.claims c set fraud_score = s.score
from (
  select claim_id, least(100, sum(contribution))::smallint as score
  from public.claim_fraud_flags where not resolved group by claim_id
) s
where s.claim_id = c.id;

-- ---------------------------------------------------------------------------
-- 11. Reserves as ledger rows with an authority decision
-- ---------------------------------------------------------------------------
alter table public.reserves rename column assessment_id to evaluation_id;
alter table public.reserves rename column requested_by to set_by;
alter table public.reserves rename column requested_at to effective_at;
alter table public.reserves rename column decided_at to approved_at;
alter table public.reserves rename column status to approval_status;
alter table public.reserves rename column reason to notes;
alter table public.reserves rename constraint reserves_assessment_id_fkey to reserves_evaluation_id_fkey;
alter table public.reserves rename constraint reserves_requested_by_fkey to reserves_set_by_fkey;
alter table public.reserves drop constraint reserves_status_check;
alter table public.reserves drop constraint reserves_amount_check;
drop index public.reserves_one_pending;
alter table public.reserves
  add column coverage_line text,
  add column prev_amount numeric(14, 2),
  add column reason_code text not null default 'INITIAL',
  add column ai_run_ref uuid,
  add column authority_ok boolean,
  add column approved_by uuid references public.users (id),
  add column review_comment text,
  add column created_by uuid references public.users (id),
  add column updated_by uuid references public.users (id),
  add column version integer not null default 1;

update public.reserves r set
  approval_status = case r.approval_status when 'PENDING_APPROVAL' then 'PENDING_REVIEW' else r.approval_status end,
  authority_ok = false,
  coverage_line = (select case c.claim_type
      when 'MOTOR' then 'OWN_DAMAGE' when 'PROPERTY' then 'BUILDING' when 'HEALTH' then 'MEDICAL'
      when 'TRAVEL' then 'TRAVEL' when 'LIABILITY' then 'LIABILITY' else 'PRIMARY' end
    from public.claims c where c.id = r.claim_id),
  approved_by = (select a.decided_by from public.approvals a
    where a.reserve_id = r.id and a.decision = 'APPROVED' order by a.decided_at desc limit 1),
  review_comment = (select a.comments from public.approvals a
    where a.reserve_id = r.id order by a.decided_at desc limit 1),
  prev_amount = (select r2.amount from public.reserves r2
    where r2.claim_id = r.claim_id and r2.effective_at < r.effective_at order by r2.effective_at desc limit 1),
  created_by = r.set_by;

alter table public.reserves alter column coverage_line set not null;
alter table public.reserves alter column authority_ok set not null;
alter table public.reserves
  add constraint reserves_amount_check check (amount >= 0),
  add constraint reserves_status_check
    check (approval_status in ('POSTED', 'PENDING_REVIEW', 'APPROVED', 'MODIFIED', 'REJECTED', 'RETURNED', 'SUPERSEDED')),
  add constraint reserves_reason_code_check check (reason_code in ('INITIAL', 'REVISED_ESTIMATE', 'NEW_INFORMATION',
    'MANAGER_MODIFIED', 'PAYMENT_ISSUED', 'CLOSURE_RELEASE', 'AI_RECOMMENDATION_ACCEPTED', 'OTHER')),
  -- Within authority a reserve is posted directly; outside authority it needs a manager decision.
  add constraint reserves_authority_rule check (
    (authority_ok and approval_status in ('POSTED', 'SUPERSEDED'))
    or (not authority_ok and approval_status in ('PENDING_REVIEW', 'REJECTED', 'RETURNED', 'SUPERSEDED', 'MODIFIED'))
    or (not authority_ok and approval_status = 'APPROVED' and approved_by is not null)),
  add constraint reserves_no_self_approval check (approved_by is null or approved_by <> set_by);
create unique index reserves_one_pending on public.reserves (claim_id, coverage_line) where approval_status = 'PENDING_REVIEW';
create index reserves_ledger_idx on public.reserves (claim_id, coverage_line, effective_at desc);

-- ---------------------------------------------------------------------------
-- 12. Payments: settlements merged in, approval steps, payees and blocks
-- ---------------------------------------------------------------------------
alter table public.payments drop constraint payments_status_check;
alter table public.payments rename column transaction_reference to portal_reference;
alter table public.payments rename column paid_at to issued_at;
alter table public.payments rename column reconciled_at to cleared_at;
alter table public.payments rename constraint payments_transaction_reference_key to payments_portal_reference_key;
alter table public.payments alter column settlement_id drop not null;
alter table public.payments alter column beneficiary_account drop not null;
alter table public.payments
  add column evaluation_id uuid references public.evaluations (id),
  add column payee_id uuid references public.payees (id),
  add column method text not null default 'EFT' check (method in ('EFT', 'CHECK')),
  add column requested_by uuid references public.users (id),
  add column requested_at timestamptz,
  add column approved_by uuid references public.users (id),
  add column approved_at timestamptz,
  add column notes text,
  add column block_reason text,
  add column updated_by uuid references public.users (id),
  add column version integer not null default 1;

update public.payments p set
  evaluation_id = s.assessment_id,
  requested_by = s.requested_by,
  requested_at = s.requested_at,
  approved_at = s.decided_at,
  notes = s.notes,
  approved_by = (select a.decided_by from public.approvals a
    where a.settlement_id = s.id and a.decision = 'APPROVED' order by a.decided_at desc limit 1)
from public.settlements s
where s.id = p.settlement_id;

insert into public.payments (claim_id, settlement_id, amount, currency, status, beneficiary_name, beneficiary_bank,
  beneficiary_account, provider, is_simulated, evaluation_id, requested_by, requested_at, approved_at, notes,
  created_by, created_at, updated_at)
select s.claim_id, s.id, s.amount, s.currency,
  case s.status when 'APPROVED' then 'PENDING' else s.status end,
  s.beneficiary_name, s.beneficiary_bank, s.beneficiary_account, 'SIMULATED', true, s.assessment_id,
  s.requested_by, s.requested_at, s.decided_at, s.notes, s.requested_by, s.created_at, s.updated_at
from public.settlements s
where not exists (select 1 from public.payments p where p.settlement_id = s.id);

insert into public.payees (customer_id, name, bank_name, bank_details_encrypted, bank_last4,
  verification_status, verified_at, verification_notes)
select distinct on (c.customer_id, p.beneficiary_name, p.beneficiary_account)
  c.customer_id, p.beneficiary_name, p.beneficiary_bank,
  case when nullif(p.beneficiary_account, '') is not null then 'plain:' || p.beneficiary_account end,
  right(nullif(p.beneficiary_account, ''), 4),
  case when nullif(p.beneficiary_account, '') is not null then 'VERIFIED' else 'UNVERIFIED' end,
  case when nullif(p.beneficiary_account, '') is not null then now() end,
  'Migrated from settlement beneficiary details'
from public.payments p join public.claims c on c.id = p.claim_id
where not exists (
  select 1 from public.payees y
  where y.customer_id = c.customer_id and y.name = p.beneficiary_name
    and y.bank_details_encrypted is not distinct from
      (case when nullif(p.beneficiary_account, '') is not null then 'plain:' || p.beneficiary_account end))
order by c.customer_id, p.beneficiary_name, p.beneficiary_account;

update public.payments p set payee_id = y.id
from public.claims c, public.payees y
where c.id = p.claim_id and y.customer_id = c.customer_id and y.name = p.beneficiary_name
  and y.bank_details_encrypted is not distinct from
    (case when nullif(p.beneficiary_account, '') is not null then 'plain:' || p.beneficiary_account end);

create table public.settlement_approval_steps (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  step_no integer not null check (step_no >= 1),
  required_role text not null references public.roles (code),
  approver_id uuid references public.users (id),
  authority_limit_id uuid references public.authority_limits (id),
  approver_limit_at_decision numeric(14, 2),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'RETURNED')),
  decided_at timestamptz,
  comment text,
  created_at timestamptz not null default now(),
  unique (payment_id, step_no),
  check (status = 'PENDING' or (approver_id is not null and decided_at is not null))
);
create index settlement_steps_pending_idx on public.settlement_approval_steps (required_role) where status = 'PENDING';

insert into public.settlement_approval_steps (payment_id, step_no, required_role, approver_id, approver_limit_at_decision,
  status, decided_at, comment, created_at)
select p.id, row_number() over (partition by p.id order by a.decided_at), 'OPS_MANAGER', a.decided_by, a.approver_limit,
  a.decision, a.decided_at, a.comments, a.created_at
from public.approvals a join public.payments p on p.settlement_id = a.settlement_id
where a.approval_type = 'SETTLEMENT';

insert into public.settlement_approval_steps (payment_id, step_no, required_role, status, created_at)
select p.id,
  coalesce((select max(s.step_no) from public.settlement_approval_steps s where s.payment_id = p.id), 0) + 1,
  case when p.amount <= coalesce((select al.max_amount from public.authority_limits al
      where al.role = 'PAYMENT_OPERATOR' and al.limit_type = 'SETTLEMENT' and al.segment = c.segment
        and al.coverage_line = '*' and al.effective_to is null), 0)
    then 'PAYMENT_OPERATOR' else 'OPS_MANAGER' end,
  'PENDING', now()
from public.payments p join public.claims c on c.id = p.claim_id
where p.status = 'PENDING_APPROVAL';

create table public.payment_blocks (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  block_type text not null check (block_type in ('PAYMENT_FAILED', 'COMPLIANCE_HOLD', 'PAYEE_UNVERIFIED', 'BANK_DETAILS_CHANGED')),
  detail text,
  opened_at timestamptz not null default now(),
  opened_by uuid references public.users (id),
  owner_task_id uuid references public.tasks (id) on delete set null,
  resolved_by uuid references public.users (id),
  resolved_at timestamptz,
  resolution text,
  check (resolved_at is null or (resolved_by is not null and resolution is not null))
);
create index payment_blocks_open_idx on public.payment_blocks (payment_id) where resolved_at is null;

insert into public.payment_blocks (payment_id, block_type, detail, opened_at)
select p.id, 'PAYMENT_FAILED', coalesce(p.last_failure_reason, 'Payment failed'), p.updated_at
from public.payments p where p.status = 'FAILED';

drop table public.approvals;
alter table public.payments
  drop column settlement_id,
  drop column beneficiary_name,
  drop column beneficiary_bank,
  drop column beneficiary_account;
drop table public.settlements;
drop table public.compliance_reviews;

alter table public.payments add constraint payments_status_check check (status in
  ('PENDING_APPROVAL', 'PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED', 'REJECTED', 'RETURNED', 'CANCELLED'));
create unique index payments_one_active on public.payments (claim_id)
  where status in ('PENDING_APPROVAL', 'PENDING', 'PROCESSING', 'FAILED');
create index payments_claim_idx on public.payments (claim_id);
create index payments_payee_idx on public.payments (payee_id);

-- ---------------------------------------------------------------------------
-- 13. Notifications: one row per channel
-- ---------------------------------------------------------------------------
alter table public.notifications rename column type to template;
alter table public.notifications rename column email_provider_message_id to provider_message_id;
alter table public.notifications
  add column recipient_type text not null default 'USER' check (recipient_type in ('USER')),
  add column channel text not null default 'IN_APP' check (channel in ('IN_APP', 'EMAIL', 'SMS', 'PUSH')),
  add column status text,
  add column sent_at timestamptz;

insert into public.notifications (recipient_id, claim_id, template, title, message, link, channel, status, sent_at,
  provider_message_id, created_at)
select recipient_id, claim_id, template, title, message, link, 'EMAIL', email_status, created_at, provider_message_id, created_at
from public.notifications
where channel = 'IN_APP' and email_status in ('PENDING', 'LOGGED_DEV', 'SENT', 'FAILED');

update public.notifications set
  status = case when is_read then 'READ' else 'DELIVERED' end,
  sent_at = created_at,
  provider_message_id = null
where channel = 'IN_APP';

alter table public.notifications alter column status set not null;
alter table public.notifications add constraint notifications_status_check
  check (status in ('PENDING', 'DELIVERED', 'READ', 'LOGGED_DEV', 'SENT', 'FAILED', 'NOT_REQUESTED'));
drop index public.notifications_recipient_idx;
alter table public.notifications drop column is_read, drop column email_status;
create index notifications_inbox_idx on public.notifications (recipient_id, channel, read_at, created_at desc);

-- ---------------------------------------------------------------------------
-- 14. Audit log: partitioned by month, append-only and hash-chained
-- ---------------------------------------------------------------------------
alter table public.audit_logs rename to audit_logs_legacy;
alter table public.audit_logs_legacy rename constraint audit_logs_pkey to audit_logs_legacy_pkey;
drop index public.audit_logs_claim_idx;
drop index public.audit_logs_entity_idx;
drop index public.audit_logs_actor_idx;
drop index public.audit_logs_created_idx;

create sequence public.audit_chain_seq;

-- No foreign keys: audit rows reference any entity and must survive archival.
create table public.audit_logs (
  id uuid not null default gen_random_uuid(),
  -- Chain position, assigned by the audit_logs_chain trigger under a lock.
  seq bigint not null,
  occurred_at timestamptz not null default now(),
  actor_id uuid,
  actor_type text not null default 'USER' check (actor_type in ('USER', 'AGENT', 'SYSTEM')),
  actor_roles text[] not null default '{}',
  action text not null,
  entity_type text not null,
  entity_id uuid,
  claim_id uuid,
  before jsonb,
  after jsonb,
  metadata jsonb not null default '{}'::jsonb,
  ip text,
  request_id text,
  hash_prev text,
  hash text not null,
  primary key (id, occurred_at)
) partition by range (occurred_at);
create table public.audit_logs_default partition of public.audit_logs default;
select public.create_monthly_partitions('audit_logs', date '2026-01-01', 24);
create index audit_logs_seq_idx on public.audit_logs (seq);
create index audit_logs_claim_idx on public.audit_logs (claim_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on public.audit_logs (actor_id, occurred_at desc);
create index audit_logs_occurred_idx on public.audit_logs (occurred_at desc);

-- Canonical text of an audit row; timestamps are rendered in UTC so the hash
-- does not depend on the session time zone.
create or replace function public.audit_payload(p_id uuid, p_seq bigint, p_occurred_at timestamptz, p_actor_id uuid,
  p_actor_type text, p_action text, p_entity_type text, p_entity_id uuid, p_claim_id uuid, p_before jsonb,
  p_after jsonb, p_metadata jsonb, p_request_id text, p_ip text)
returns text language sql immutable as $$
  select jsonb_build_object(
    'id', p_id, 'seq', p_seq,
    'occurred_at', to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_id', p_actor_id, 'actor_type', p_actor_type, 'action', p_action,
    'entity_type', p_entity_type, 'entity_id', p_entity_id, 'claim_id', p_claim_id,
    'before', p_before, 'after', p_after, 'metadata', p_metadata,
    'request_id', p_request_id, 'ip', p_ip)::text
$$;

create or replace function public.audit_logs_chain() returns trigger
language plpgsql as $$
declare
  v_prev text;
begin
  -- Serialize writers so every row links to the row committed just before it.
  perform pg_advisory_xact_lock(hashtext('public.audit_logs.chain'));
  select a.hash into v_prev from public.audit_logs a order by a.seq desc limit 1;
  new.seq := nextval('public.audit_chain_seq');
  new.hash_prev := v_prev;
  new.hash := public.sha256_hex(coalesce(v_prev, '') || '|' || public.audit_payload(new.id, new.seq, new.occurred_at,
    new.actor_id, new.actor_type, new.action, new.entity_type, new.entity_id, new.claim_id, new.before, new.after,
    new.metadata, new.request_id, new.ip));
  return new;
end;
$$;
create trigger audit_logs_chain before insert on public.audit_logs
  for each row execute function public.audit_logs_chain();

insert into public.audit_logs (id, occurred_at, actor_id, actor_type, actor_roles, action, entity_type, entity_id,
  claim_id, before, after, metadata, ip, request_id)
select id, created_at, actor_id, case when actor_id is null then 'SYSTEM' else 'USER' end, actor_roles, action,
  entity_type, entity_id, claim_id, before_data, after_data, metadata, ip_address, request_id
from public.audit_logs_legacy
order by created_at, id;
drop table public.audit_logs_legacy;

create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.prevent_modification();

/** Returns every row whose link or hash does not match a recomputation (empty when the chain is intact). */
create or replace function public.verify_audit_chain()
returns table (seq bigint, id uuid, problem text) language plpgsql stable as $$
declare
  r record;
  v_prev text := null;
  v_expected text;
begin
  for r in select * from public.audit_logs a order by a.seq loop
    v_expected := public.sha256_hex(coalesce(v_prev, '') || '|' || public.audit_payload(r.id, r.seq, r.occurred_at,
      r.actor_id, r.actor_type, r.action, r.entity_type, r.entity_id, r.claim_id, r.before, r.after, r.metadata,
      r.request_id, r.ip));
    if r.hash_prev is distinct from v_prev then
      seq := r.seq; id := r.id; problem := 'BROKEN_LINK'; return next;
    elsif r.hash <> v_expected then
      seq := r.seq; id := r.id; problem := 'HASH_MISMATCH'; return next;
    end if;
    v_prev := r.hash;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 15. Reminders, SLA clocks, closure, recoveries, integrations, consents
-- ---------------------------------------------------------------------------
alter table public.claim_reminders rename column document_categories to doc_types;
alter table public.claim_reminders rename column information_request_ids to artifact_requirement_ids;

create table public.sla_clocks (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  clock_type text not null check (clock_type in ('ACKNOWLEDGE', 'STAGE')),
  stage text not null,
  segment text not null default 'PERSONAL',
  started_at timestamptz not null default now(),
  due_at timestamptz,
  paused_at timestamptz,
  paused_seconds integer not null default 0 check (paused_seconds >= 0),
  pause_reason text,
  stopped_at timestamptz,
  breached_at timestamptz,
  escalation_level smallint not null default 0 check (escalation_level between 0 and 3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index sla_clocks_one_running on public.sla_clocks (claim_id, clock_type) where stopped_at is null;
create index sla_clocks_due_idx on public.sla_clocks (due_at) where stopped_at is null and paused_at is null;

insert into public.sla_clocks (claim_id, clock_type, stage, segment, started_at, due_at, paused_at, pause_reason, breached_at)
select c.id, 'STAGE', coalesce(c.hold_from_status, c.status), c.segment,
  coalesce((select max(h.created_at) from public.claim_status_history h where h.claim_id = c.id), c.created_at),
  c.due_date,
  case when c.status in ('DOCUMENTS_REQUIRED', 'ON_HOLD') then now() end,
  case c.status when 'DOCUMENTS_REQUIRED' then 'Waiting on client documents' when 'ON_HOLD' then 'Claim on hold' end,
  case when c.due_date < now() and c.status not in ('DOCUMENTS_REQUIRED', 'ON_HOLD') then c.due_date end
from public.claims c
where c.status in ('SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW', 'ADJUSTER_ASSIGNMENT',
  'INVESTIGATION', 'RESERVE_APPROVAL', 'COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED',
  'PAID', 'REOPENED', 'ON_HOLD');

create table public.closure_requests (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  requested_by uuid not null references public.users (id),
  reason text not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by uuid references public.users (id),
  decided_at timestamptz,
  decision_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (decided_by is null or decided_by <> requested_by),
  check (status in ('PENDING', 'CANCELLED') or (decided_by is not null and decided_at is not null))
);
create unique index closure_requests_one_pending on public.closure_requests (claim_id) where status = 'PENDING';

create table public.recoveries (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  type text not null check (type in ('SUBROGATION', 'SALVAGE')),
  target_party text,
  description text,
  expected_amount numeric(14, 2) check (expected_amount is null or expected_amount >= 0),
  recovered_amount numeric(14, 2) not null default 0 check (recovered_amount >= 0),
  currency char(3) not null default 'USD',
  status text not null default 'IDENTIFIED'
    check (status in ('IDENTIFIED', 'REFERRED', 'IN_PROGRESS', 'RECOVERED', 'CLOSED', 'ABANDONED')),
  deadline date,
  created_by uuid references public.users (id),
  updated_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);
create index recoveries_claim_idx on public.recoveries (claim_id);

create table public.claim_xref (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  source_system text not null,
  external_claim_id text not null,
  match_method text not null check (match_method in ('EXACT', 'RULE', 'MANUAL')),
  match_confidence numeric(4, 3) check (match_confidence is null or match_confidence between 0 and 1),
  status text not null default 'LINKED' check (status in ('LINKED', 'PENDING_REVIEW', 'REJECTED')),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_system, external_claim_id)
);
create index claim_xref_claim_idx on public.claim_xref (claim_id);

create table public.source_precedence (
  field_group text not null,
  source_system text not null,
  rank integer not null check (rank >= 1),
  rule text not null check (rule in ('SOURCE_WINS', 'HUB_WINS', 'LATEST_WINS', 'MANUAL_REVIEW')),
  updated_by uuid references public.users (id),
  updated_at timestamptz not null default now(),
  primary key (field_group, source_system)
);
insert into public.source_precedence (field_group, source_system, rank, rule) values
  ('POLICY', 'POLICY_ADMIN', 1, 'SOURCE_WINS'),
  ('PAYMENT_STATUS', 'PAYMENT_PORTAL', 1, 'SOURCE_WINS'),
  ('DOCUMENT_METADATA', 'DOCUMENT_MANAGEMENT', 1, 'SOURCE_WINS'),
  ('CLAIM_HISTORY', 'LEGACY_CLAIMS', 1, 'SOURCE_WINS'),
  ('ASSIGNMENT', 'ADJUSTER_ASSIGNMENT', 1, 'LATEST_WINS'),
  ('WORKFLOW', 'HUB', 1, 'HUB_WINS');

create table public.integration_sync_runs (
  id uuid primary key default gen_random_uuid(),
  source_system text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_in integer not null default 0 check (records_in >= 0),
  records_failed integer not null default 0 check (records_failed >= 0),
  status text not null default 'RUNNING' check (status in ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL')),
  checkpoint text,
  error text,
  triggered_by uuid references public.users (id)
);
create index integration_sync_runs_source_idx on public.integration_sync_runs (source_system, started_at desc);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.users (id) on delete cascade,
  claim_id uuid references public.claims (id) on delete cascade,
  consent_type text not null check (consent_type in ('PRIVACY_NOTICE', 'CLAIM_DECLARATION', 'CHANNEL_EMAIL',
    'CHANNEL_SMS', 'CHANNEL_PUSH', 'LOCATION', 'AUDIO_RECORDING')),
  notice_version text not null,
  granted boolean not null,
  channel text not null default 'WEB',
  recorded_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index consents_subject_idx on public.consents (subject_id, consent_type, recorded_at desc);

insert into public.consents (subject_id, claim_id, consent_type, notice_version, granted, recorded_at)
select customer_id, id, 'CLAIM_DECLARATION', 'pre-2026-10', true, declaration_accepted_at
from public.claims where declaration_accepted and declaration_accepted_at is not null;

-- ---------------------------------------------------------------------------
-- 16. Business-rule triggers for the new model
-- ---------------------------------------------------------------------------
create or replace function public.has_active_compliance_hold(p_claim_id uuid) returns boolean
language sql stable as $$
  select exists (select 1 from public.reviews r
    where r.claim_id = p_claim_id and r.checkpoint_type = 'COMPLIANCE' and r.hold_active)
$$;

create or replace function public.enforce_claim_status_rules() returns trigger
language plpgsql as $$
begin
  new.stage := public.claim_stage(new.status, new.hold_from_status);

  if tg_op = 'INSERT' then
    if new.status <> 'DRAFT' and not public.is_seed_mode() then
      raise exception 'INVALID_STATUS_TRANSITION: new claims must start as DRAFT (got %)', new.status
        using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not exists (
      select 1 from public.claim_status_transitions
      where from_status = old.status and to_status = new.status
    ) then
      raise exception 'INVALID_STATUS_TRANSITION: % -> % is not permitted', old.status, new.status
        using errcode = 'P0001';
    end if;

    if old.status = 'ON_HOLD' and new.status not in ('REJECTED', 'WITHDRAWN')
       and new.status is distinct from old.hold_from_status then
      raise exception 'INVALID_STATUS_TRANSITION: claim on hold can only resume to %', old.hold_from_status
        using errcode = 'P0001';
    end if;

    if new.status in ('SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAID') and public.has_active_compliance_hold(new.id) then
      raise exception 'COMPLIANCE_HOLD_ACTIVE: claim % has an active compliance hold', new.id
        using errcode = 'P0001';
    end if;

    if new.status = 'PAYMENT_PENDING' and old.status = 'SETTLEMENT_APPROVAL' and not exists (
      select 1 from public.payments where claim_id = new.id and status = 'PENDING'
    ) then
      raise exception 'SETTLEMENT_NOT_APPROVED: claim % has no approved settlement', new.id
        using errcode = 'P0001';
    end if;

    if new.status = 'CLOSED' and old.status = 'PAID' and exists (
      select 1 from public.tasks
      where claim_id = new.id and blocking and status in ('OPEN', 'IN_PROGRESS')
    ) then
      raise exception 'OPEN_MANDATORY_TASKS: claim % has open blocking tasks', new.id
        using errcode = 'P0001';
    end if;

    if new.status = 'REOPENED' then
      new.reopen_count := old.reopen_count + 1;
    end if;
  end if;
  return new;
end;
$$;

-- Settlements and payments share one state machine.
create or replace function public.enforce_payment_rules() returns trigger
language plpgsql as $$
declare
  v_payee_status text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING_APPROVAL' and not public.is_seed_mode() then
      raise exception 'INVALID_PAYMENT_STATE: settlements must be created as PENDING_APPROVAL' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.amount is distinct from old.amount and old.status <> 'PENDING_APPROVAL' then
    raise exception 'IMMUTABLE_RECORD: the amount of an approved settlement cannot change' using errcode = 'P0001';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'PENDING_APPROVAL' and new.status in ('PENDING', 'REJECTED', 'RETURNED', 'CANCELLED')) or
      (old.status = 'PENDING' and new.status in ('PROCESSING', 'CANCELLED')) or
      (old.status = 'PROCESSING' and new.status in ('PAID', 'FAILED')) or
      (old.status = 'FAILED' and new.status in ('PENDING', 'CANCELLED')) or
      (old.status = 'PAID' and new.status = 'RECONCILED')
    ) then
      raise exception 'INVALID_PAYMENT_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
    end if;

    if old.status = 'PENDING_APPROVAL' and new.status = 'PENDING' and (
      not exists (select 1 from public.settlement_approval_steps where payment_id = new.id)
      or exists (select 1 from public.settlement_approval_steps where payment_id = new.id and status <> 'APPROVED')
    ) then
      raise exception 'SETTLEMENT_NOT_APPROVED: every settlement approval step must be approved' using errcode = 'P0001';
    end if;

    if new.status = 'PROCESSING' then
      if public.has_active_compliance_hold(new.claim_id) then
        raise exception 'COMPLIANCE_HOLD_ACTIVE: payment blocked by compliance hold' using errcode = 'P0001';
      end if;
      select verification_status into v_payee_status from public.payees where id = new.payee_id;
      if v_payee_status is distinct from 'VERIFIED' then
        raise exception 'PAYEE_NOT_VERIFIED: the payee must be verified before payment' using errcode = 'P0001';
      end if;
      if exists (select 1 from public.payment_blocks where payment_id = new.id and resolved_at is null) then
        raise exception 'PAYMENT_BLOCKED: open payment blocks must be resolved first' using errcode = 'P0001';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- Approval steps: the approver holds the required role, did not prepare the
-- settlement and has enough authority for the segment. Decided steps are final.
create or replace function public.enforce_settlement_step() returns trigger
language plpgsql as $$
declare
  v_payment public.payments%rowtype;
  v_segment text;
  v_limit numeric(14, 2);
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD: settlement approval steps cannot be deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.status <> 'PENDING' then
    raise exception 'IMMUTABLE_RECORD: decided approval steps cannot change' using errcode = 'P0001';
  end if;
  if new.status = 'PENDING' or (tg_op = 'INSERT' and public.is_seed_mode()) then
    return new;
  end if;

  if not exists (select 1 from public.user_roles where user_id = new.approver_id and role_code = new.required_role) then
    raise exception 'APPROVAL_NOT_AUTHORISED: approver does not hold %', new.required_role using errcode = 'P0001';
  end if;
  select * into v_payment from public.payments where id = new.payment_id;
  if v_payment.requested_by = new.approver_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN: the preparer of a settlement cannot approve it' using errcode = 'P0001';
  end if;
  select segment into v_segment from public.claims where id = v_payment.claim_id;
  v_limit := public.effective_limit(new.approver_id, 'SETTLEMENT', v_segment, '*');
  if new.status = 'APPROVED' and (v_limit is null or v_payment.amount > v_limit) then
    raise exception 'APPROVAL_LIMIT_EXCEEDED: % exceeds approval limit %', v_payment.amount, coalesce(v_limit, 0)
      using errcode = 'P0001';
  end if;
  new.approver_limit_at_decision := v_limit;
  new.decided_at := coalesce(new.decided_at, now());
  return new;
end;
$$;

-- Separation of duties: whoever approved a settlement cannot issue its payment.
create or replace function public.enforce_issuer_not_approver() returns trigger
language plpgsql as $$
begin
  if public.is_seed_mode() then
    return new;
  end if;
  if exists (
    select 1 from public.settlement_approval_steps
    where payment_id = new.payment_id and status = 'APPROVED' and approver_id = new.initiated_by
  ) then
    raise exception 'SEPARATION_OF_DUTIES: the approver of a settlement cannot issue its payment' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Reverse-review decisions are final; compliance reviews stay editable until decided.
create or replace function public.enforce_review_rules() returns trigger
language plpgsql as $$
declare
  v_reserve public.reserves%rowtype;
  v_segment text;
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD: reviews cannot be deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    if old.checkpoint_type <> 'COMPLIANCE' then
      raise exception 'IMMUTABLE_RECORD: review decisions cannot be modified' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.checkpoint_type in ('RESERVE', 'EVALUATION', 'CLOSURE') and not public.is_seed_mode() then
    if not exists (select 1 from public.user_roles where user_id = new.decided_by and role_code = 'OPS_MANAGER') then
      raise exception 'APPROVAL_NOT_AUTHORISED: reverse reviews are decided by an OPS_MANAGER' using errcode = 'P0001';
    end if;
  end if;

  if new.checkpoint_type = 'RESERVE' then
    select * into v_reserve from public.reserves where id = new.subject_id;
    select segment into v_segment from public.claims where id = new.claim_id;
    new.approver_limit := public.effective_limit(new.decided_by, 'RESERVE', v_segment, v_reserve.coverage_line);
    if new.outcome in ('APPROVED', 'MODIFIED') and (new.approver_limit is null or new.amount > new.approver_limit) then
      raise exception 'APPROVAL_LIMIT_EXCEEDED: % exceeds reserve authority %', new.amount, coalesce(new.approver_limit, 0)
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

-- Reserves are a ledger: amounts never change after insert.
create or replace function public.reserves_protect_ledger() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'IMMUTABLE_RECORD: reserve entries cannot be deleted' using errcode = 'P0001';
  end if;
  if new.amount is distinct from old.amount or new.prev_amount is distinct from old.prev_amount
     or new.claim_id is distinct from old.claim_id or new.coverage_line is distinct from old.coverage_line
     or new.set_by is distinct from old.set_by or new.effective_at is distinct from old.effective_at
     or new.authority_ok is distinct from old.authority_ok then
    raise exception 'IMMUTABLE_RECORD: reserve amounts are ledger entries; record a new reserve instead' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.ai_runs_protect_output() returns trigger
language plpgsql as $$
begin
  if new.agent is distinct from old.agent or new.claim_id is distinct from old.claim_id
     or new.document_id is distinct from old.document_id or new.provider is distinct from old.provider
     or new.model is distinct from old.model or new.status is distinct from old.status
     or new.output is distinct from old.output or new.input_hash is distinct from old.input_hash
     or new.prompt_version is distinct from old.prompt_version or new.requested_by is distinct from old.requested_by
     or new.created_at is distinct from old.created_at then
    raise exception 'IMMUTABLE_RECORD: AI run results cannot be modified' using errcode = 'P0001';
  end if;
  if old.human_decision in ('ACCEPTED', 'REJECTED') then
    raise exception 'ALREADY_REVIEWED: this AI result has already been reviewed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function public.recompute_fraud_score() returns trigger
language plpgsql as $$
declare
  v_claim uuid := coalesce(new.claim_id, old.claim_id);
begin
  -- least() ignores NULLs, so "no unresolved flags" must map to NULL explicitly.
  update public.claims set fraud_score = (
    select case when count(*) = 0 then null else least(100, sum(contribution))::smallint end
    from public.claim_fraud_flags
    where claim_id = v_claim and not resolved)
  where id = v_claim;
  return null;
end;
$$;

drop trigger if exists payments_enforce_rules on public.payments;
create trigger payments_enforce_rules before insert or update on public.payments
  for each row execute function public.enforce_payment_rules();
create trigger settlement_steps_enforce before insert or update or delete on public.settlement_approval_steps
  for each row execute function public.enforce_settlement_step();
create trigger payment_attempts_issuer_check before insert on public.payment_attempts
  for each row execute function public.enforce_issuer_not_approver();
create trigger reviews_enforce before insert or update or delete on public.reviews
  for each row execute function public.enforce_review_rules();
create trigger reserves_protect_ledger before update or delete on public.reserves
  for each row execute function public.reserves_protect_ledger();
create trigger ai_runs_protect_output before update on public.ai_runs
  for each row execute function public.ai_runs_protect_output();
create trigger ai_runs_no_delete before delete on public.ai_runs
  for each row execute function public.prevent_modification();
create trigger claim_fraud_flags_score after insert or update or delete on public.claim_fraud_flags
  for each row execute function public.recompute_fraud_score();
create trigger policy_snapshots_immutable before update or delete on public.policy_snapshots
  for each row execute function public.prevent_modification();
create trigger coverage_results_immutable before update or delete on public.coverage_results
  for each row execute function public.prevent_modification();
create trigger document_versions_final before delete on public.document_versions
  for each row execute function public.prevent_modification();

do $$
declare t text;
begin
  foreach t in array array['user_attributes', 'payees', 'claim_parties', 'reviews', 'claim_fraud_flags', 'sla_clocks',
    'closure_requests', 'recoveries', 'ai_runs']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t, t);
  end loop;
  foreach t in array array['users', 'user_attributes', 'policies', 'claims', 'claim_parties', 'artifact_requirements',
    'tasks', 'reserves', 'payments', 'payees', 'reviews', 'recoveries']
  loop
    execute format('create trigger %I_bump_version before update on public.%I
                    for each row execute function public.bump_version()', t, t);
  end loop;
end;
$$;

drop function if exists public.enforce_approval_authority();
drop function if exists public.ai_runs_protect_result();

do $$
declare t text;
begin
  foreach t in array array['users', 'user_roles', 'policies', 'claims', 'artifact_requirements', 'documents', 'tasks',
    'evaluations', 'reserves', 'payments', 'payment_attempts', 'notifications', 'claim_reminders']
  loop
    execute format('alter table public.%I enable trigger user', t);
  end loop;
end;
$$;

drop table tmp_role_map;
drop table tmp_doc_latest;
drop table tmp_required;
drop table tmp_req_docs;

-- ---------------------------------------------------------------------------
-- 17. Row-level security for the seven roles
-- ---------------------------------------------------------------------------
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end;
$$;

create or replace function public.has_role(p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.users u on u.id = ur.user_id
    where ur.user_id = auth.uid() and ur.role_code = p_role and u.is_active
  )
$$;

create or replace function public.has_any_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.users u on u.id = ur.user_id
    where ur.user_id = auth.uid() and ur.role_code = any (p_roles) and u.is_active
  )
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_any_role(array['OPS_MANAGER', 'ADJUSTER', 'DOCUMENT_REVIEWER', 'PAYMENT_OPERATOR',
    'DATA_ENGINEER', 'COMPLIANCE_SECURITY'])
$$;

-- Mirrors server/src/services/access.service.js (claim scope rules). Data
-- engineers read claim headers only (claims_data_engineer_read), so they are
-- deliberately not included here.
create or replace function public.can_access_claim(p_claim_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.claims c
    where c.id = p_claim_id and (
      c.customer_id = auth.uid()
      or (c.status = 'DRAFT' and c.created_by = auth.uid())
      or (c.status <> 'DRAFT' and (
        public.has_any_role(array['OPS_MANAGER', 'COMPLIANCE_SECURITY'])
        or (public.has_role('DOCUMENT_REVIEWER') and (
              c.status in ('POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW')
              or c.assigned_reviewer_id = auth.uid()))
        or (public.has_role('ADJUSTER') and exists (
              select 1 from public.claim_assignments a
              where a.claim_id = c.id and a.assignee_id = auth.uid() and a.assignment_role = 'ADJUSTER'))
        or (public.has_role('PAYMENT_OPERATOR') and (
              c.status in ('SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID')
              or exists (select 1 from public.payments pm where pm.claim_id = c.id)))
      ))
    )
  )
$$;

create or replace function public.can_staff_access_claim(p_claim_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() and public.can_access_claim(p_claim_id)
$$;

revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update on public.claims to authenticated;
grant update (full_name, phone) on public.users to authenticated;
grant update (read_at, status) on public.notifications to authenticated;
grant insert, update, delete on public.user_roles to authenticated;

-- Partitions are reached only through their parent table.
do $$
declare r record;
begin
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relispartition and c.relkind = 'r' loop
    execute format('revoke all on public.%I from anon, authenticated', r.relname);
  end loop;
  for r in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('alter table public.%I enable row level security', r.relname);
  end loop;
end;
$$;

-- Reference data and configuration
create policy roles_read on public.roles for select to authenticated using (true);
create policy transitions_read on public.claim_status_transitions for select to authenticated using (true);
create policy fraud_reason_codes_read on public.fraud_reason_codes for select to authenticated using (public.is_staff());
create policy segment_config_read on public.segment_config for select to authenticated using (public.is_staff());
create policy authority_limits_read on public.authority_limits for select to authenticated using (public.is_staff());
create policy source_precedence_read on public.source_precedence for select to authenticated
  using (public.has_any_role(array['DATA_ENGINEER', 'COMPLIANCE_SECURITY']));

-- Identity
create policy users_read on public.users for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy users_update_own on public.users for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy user_attributes_read on public.user_attributes for select to authenticated
  using (user_id = auth.uid() or public.has_any_role(array['COMPLIANCE_SECURITY', 'OPS_MANAGER']));

-- Role grants: only Compliance & Security, and never on their own account.
create policy user_roles_read on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_role('COMPLIANCE_SECURITY'));
create policy user_roles_admin_insert on public.user_roles for insert to authenticated
  with check (public.has_role('COMPLIANCE_SECURITY') and user_id <> auth.uid());
create policy user_roles_admin_update on public.user_roles for update to authenticated
  using (public.has_role('COMPLIANCE_SECURITY') and user_id <> auth.uid())
  with check (public.has_role('COMPLIANCE_SECURITY') and user_id <> auth.uid());
create policy user_roles_admin_delete on public.user_roles for delete to authenticated
  using (public.has_role('COMPLIANCE_SECURITY') and user_id <> auth.uid());
create policy consents_read on public.consents for select to authenticated
  using (subject_id = auth.uid() or public.has_role('COMPLIANCE_SECURITY'));

-- Policies and payees
create policy policies_read on public.policies for select to authenticated
  using (insured_id = auth.uid() or public.has_any_role(array['OPS_MANAGER', 'DOCUMENT_REVIEWER', 'ADJUSTER',
    'PAYMENT_OPERATOR', 'DATA_ENGINEER', 'COMPLIANCE_SECURITY']));
create policy payees_read on public.payees for select to authenticated
  using (customer_id = auth.uid() or public.has_any_role(array['PAYMENT_OPERATOR', 'OPS_MANAGER', 'COMPLIANCE_SECURITY']));

-- Claims: clients may create and edit only their own drafts. Ownership columns
-- are checked directly so a client's INSERT ... RETURNING succeeds.
create policy claims_read on public.claims for select to authenticated
  using (customer_id = auth.uid() or (status = 'DRAFT' and created_by = auth.uid()) or public.can_access_claim(id));
create policy claims_data_engineer_read on public.claims for select to authenticated
  using (status <> 'DRAFT' and public.has_role('DATA_ENGINEER'));
create policy claims_client_insert_draft on public.claims for insert to authenticated
  with check (customer_id = auth.uid() and status = 'DRAFT' and public.has_role('CLIENT'));
create policy claims_client_update_draft on public.claims for update to authenticated
  using (customer_id = auth.uid() and status = 'DRAFT')
  with check (customer_id = auth.uid() and status = 'DRAFT');

-- Claim children
create policy claim_parties_read on public.claim_parties for select to authenticated
  using (public.can_access_claim(claim_id));
create policy policy_snapshots_read on public.policy_snapshots for select to authenticated
  using (public.can_staff_access_claim(claim_id));
create policy coverage_results_read on public.coverage_results for select to authenticated
  using (public.can_staff_access_claim(claim_id));
create policy claim_assignments_read on public.claim_assignments for select to authenticated
  using (public.can_staff_access_claim(claim_id));
create policy claim_notes_read on public.claim_notes for select to authenticated
  using (public.can_access_claim(claim_id) and (visibility = 'CUSTOMER' or public.is_staff()));
create policy claim_status_history_read on public.claim_status_history for select to authenticated
  using (public.can_access_claim(claim_id) and (customer_visible or public.is_staff()));
create policy artifact_requirements_read on public.artifact_requirements for select to authenticated
  using (public.can_access_claim(claim_id));
create policy documents_read on public.documents for select to authenticated
  using (public.can_access_claim(claim_id)
    and (public.is_staff() or doc_type not in ('INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE')));
create policy document_versions_read on public.document_versions for select to authenticated
  using (exists (select 1 from public.documents d where d.id = document_id and public.can_access_claim(d.claim_id)
    and (public.is_staff() or d.doc_type not in ('INVESTIGATION_EVIDENCE', 'COMPLIANCE_EVIDENCE'))));
create policy tasks_read on public.tasks for select to authenticated
  using (public.is_staff() and (owner_user_id = auth.uid() or created_by = auth.uid()
    or (claim_id is not null and public.can_access_claim(claim_id))));
create policy task_sources_read on public.task_sources for select to authenticated
  using (public.has_role('DATA_ENGINEER')
    or exists (select 1 from public.tasks t where t.id = task_id and t.owner_user_id = auth.uid()));
create policy sla_clocks_read on public.sla_clocks for select to authenticated
  using (public.can_staff_access_claim(claim_id));

create policy evaluations_read on public.evaluations for select to authenticated
  using (public.has_any_role(array['OPS_MANAGER', 'ADJUSTER', 'COMPLIANCE_SECURITY']) and public.can_access_claim(claim_id));
create policy reserves_read on public.reserves for select to authenticated
  using (public.has_any_role(array['OPS_MANAGER', 'ADJUSTER', 'COMPLIANCE_SECURITY', 'PAYMENT_OPERATOR'])
    and public.can_access_claim(claim_id));
create policy reviews_read on public.reviews for select to authenticated
  using (public.can_access_claim(claim_id) and (
    (checkpoint_type = 'COMPLIANCE' and public.has_any_role(array['COMPLIANCE_SECURITY', 'OPS_MANAGER']))
    or (checkpoint_type <> 'COMPLIANCE' and public.has_any_role(array['OPS_MANAGER', 'ADJUSTER', 'COMPLIANCE_SECURITY']))));
-- Adjusters see only the risk band (served by the API), never individual fraud flags.
create policy claim_fraud_flags_read on public.claim_fraud_flags for select to authenticated
  using (public.has_any_role(array['COMPLIANCE_SECURITY', 'OPS_MANAGER']) and public.can_access_claim(claim_id));
create policy closure_requests_read on public.closure_requests for select to authenticated
  using (public.has_any_role(array['OPS_MANAGER', 'ADJUSTER', 'COMPLIANCE_SECURITY']) and public.can_access_claim(claim_id));
create policy recoveries_read on public.recoveries for select to authenticated
  using (public.has_any_role(array['OPS_MANAGER', 'ADJUSTER', 'COMPLIANCE_SECURITY', 'PAYMENT_OPERATOR'])
    and public.can_access_claim(claim_id));

-- Settlement and payment data
create policy payments_read on public.payments for select to authenticated
  using (public.has_any_role(array['PAYMENT_OPERATOR', 'OPS_MANAGER', 'COMPLIANCE_SECURITY'])
    and public.can_access_claim(claim_id));
create policy settlement_steps_read on public.settlement_approval_steps for select to authenticated
  using (exists (select 1 from public.payments p where p.id = payment_id
    and public.has_any_role(array['PAYMENT_OPERATOR', 'OPS_MANAGER', 'COMPLIANCE_SECURITY'])
    and public.can_access_claim(p.claim_id)));
create policy payment_attempts_read on public.payment_attempts for select to authenticated
  using (public.has_any_role(array['PAYMENT_OPERATOR', 'OPS_MANAGER', 'COMPLIANCE_SECURITY']));
create policy payment_blocks_read on public.payment_blocks for select to authenticated
  using (public.has_any_role(array['PAYMENT_OPERATOR', 'OPS_MANAGER', 'COMPLIANCE_SECURITY']));

-- Notifications: recipients only.
create policy notifications_read on public.notifications for select to authenticated
  using (recipient_id = auth.uid());
create policy notifications_mark_read on public.notifications for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- Audit: Compliance & Security see everything; Ops Managers see claim events in
-- their scope; Data Engineers see pipeline and system events.
create policy audit_logs_read on public.audit_logs for select to authenticated
  using (public.has_role('COMPLIANCE_SECURITY')
    or (public.has_role('OPS_MANAGER') and claim_id is not null and public.can_access_claim(claim_id))
    or (public.has_role('DATA_ENGINEER') and entity_type in ('integration', 'system', 'job')));

-- Automation
create policy ai_runs_read on public.ai_runs for select to authenticated
  using (public.has_any_role(array['OPS_MANAGER', 'DOCUMENT_REVIEWER', 'COMPLIANCE_SECURITY', 'ADJUSTER'])
    and public.can_access_claim(claim_id));
create policy claim_reminders_read on public.claim_reminders for select to authenticated
  using ((audience = 'INTERNAL' and recipient_id = auth.uid())
    or (public.has_any_role(array['OPS_MANAGER', 'DOCUMENT_REVIEWER', 'COMPLIANCE_SECURITY'])
        and public.can_access_claim(claim_id)));

-- Integrations
create policy claim_xref_read on public.claim_xref for select to authenticated
  using (public.has_any_role(array['DATA_ENGINEER', 'COMPLIANCE_SECURITY']));
create policy integration_sync_runs_read on public.integration_sync_runs for select to authenticated
  using (public.has_any_role(array['DATA_ENGINEER', 'COMPLIANCE_SECURITY']));
