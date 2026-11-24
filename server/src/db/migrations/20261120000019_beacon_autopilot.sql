-- Beacon AI Auto-Pilot (November 20, 2026).
--
-- Straight-through processing for routine work, exception-only review for
-- people. The auto-pilot acts through the same services (and so the same
-- workflow guards, enforce_claim_status_rules and separation-of-duties
-- triggers) as a person would. It never approves a settlement, issues a
-- payment, places a compliance hold or denies a claim.

-- ---------------------------------------------------------------------------
-- 1. Service identity
-- ---------------------------------------------------------------------------
-- ai_runs.requested_by, documents.reviewed_by and claim_assignments.assigned_by
-- reference users, so automated work needs a real row to point at. The account
-- has no password, no roles and is inactive: nobody can sign in as it. Its
-- audit entries are written with actor_type AGENT.
insert into auth.users (id, email, encrypted_password, raw_user_meta_data, raw_app_meta_data)
values (
  '00000000-0000-4000-a000-00000000bea1',
  'beacon-autopilot@system.harborpoint.invalid',
  null,
  '{"full_name": "Beacon AI Auto-Pilot"}'::jsonb,
  '{"provisioned_staff": "true", "service_account": "true"}'::jsonb
)
on conflict (id) do nothing;

-- handle_new_auth_user created the profile; make sure it is named and inactive.
insert into public.users (id, email, full_name)
values ('00000000-0000-4000-a000-00000000bea1', 'beacon-autopilot@system.harborpoint.invalid', 'Beacon AI Auto-Pilot')
on conflict (id) do nothing;
update public.users set full_name = 'Beacon AI Auto-Pilot', is_active = false
where id = '00000000-0000-4000-a000-00000000bea1';
delete from public.user_roles where user_id = '00000000-0000-4000-a000-00000000bea1';

-- ---------------------------------------------------------------------------
-- 2. On/off state (one row), changed from the Auto-Pilot control bar
-- ---------------------------------------------------------------------------
create table if not exists public.autopilot_state (
  id smallint primary key default 1 check (id = 1),
  -- null until someone uses the toggle: the AI_AUTOPILOT_ENABLED setting applies until then.
  enabled boolean,
  updated_by uuid references public.users (id),
  updated_at timestamptz not null default now(),
  last_sweep_at timestamptz,
  last_sweep jsonb
);
insert into public.autopilot_state (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Action log: one row per automated action or escalation (the metrics source)
-- ---------------------------------------------------------------------------
create table if not exists public.autopilot_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sweep_id uuid not null,
  stage text not null check (stage in ('INTAKE', 'ROUTING', 'DOCUMENT_REVIEW', 'ADJUSTER_PREWORK', 'PAYEE_SHIELD', 'FRAUD_SHIELD')),
  action text not null,
  outcome text not null check (outcome in ('AUTOMATED', 'ESCALATED')),
  claim_id uuid not null references public.claims (id) on delete cascade,
  document_id uuid references public.documents (id) on delete set null,
  -- ai_runs is partitioned (primary key id + created_at), so this is a plain reference.
  ai_run_ids uuid[] not null default '{}',
  reason_code text,
  reason text,
  minutes_saved integer not null default 0 check (minutes_saved >= 0),
  details jsonb not null default '{}'::jsonb,
  -- One escalation per subject and cause: a later sweep does not raise it again.
  dedupe_key text unique
);
create index if not exists autopilot_actions_claim_idx on public.autopilot_actions (claim_id, created_at desc);
create index if not exists autopilot_actions_created_idx on public.autopilot_actions (created_at desc);

-- Actions are evidence of what the auto-pilot did: append-only.
drop trigger if exists autopilot_actions_immutable on public.autopilot_actions;
create trigger autopilot_actions_immutable before update or delete on public.autopilot_actions
  for each row execute function public.prevent_modification();

-- ---------------------------------------------------------------------------
-- 4. Exceptions surface first in the human queues
-- ---------------------------------------------------------------------------
-- A document Beacon could not clear (fraud indicator or unreadable) goes to
-- the top of the Document Review queue.
alter table public.documents
  add column if not exists ai_escalated_at timestamptz,
  add column if not exists ai_escalation_reason text;
create index if not exists documents_ai_escalated_idx on public.documents (ai_escalated_at) where ai_escalated_at is not null;

-- A claim with high combined fraud risk is an AI-flagged priority item in the
-- Compliance queue. Flagging opens (or marks) a review; it never places a hold.
alter table public.reviews
  add column if not exists ai_priority boolean not null default false,
  add column if not exists ai_flag_reason text;

-- ---------------------------------------------------------------------------
-- 5. Row-level security (direct database access; the API enforces the same)
-- ---------------------------------------------------------------------------
alter table public.autopilot_state enable row level security;
alter table public.autopilot_actions enable row level security;
drop policy if exists autopilot_state_staff_read on public.autopilot_state;
create policy autopilot_state_staff_read on public.autopilot_state for select using (public.is_staff());
drop policy if exists autopilot_actions_staff_read on public.autopilot_actions;
create policy autopilot_actions_staff_read on public.autopilot_actions for select
  using (public.is_staff() and public.can_access_claim(claim_id));
