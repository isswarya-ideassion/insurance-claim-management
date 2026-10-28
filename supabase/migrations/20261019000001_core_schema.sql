-- HarborPoint Claims Operations Hub — core schema
-- All timestamps are timestamptz (stored in UTC). Monetary amounts use numeric(14,2).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------------------------
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  is_staff boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null default '',
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (lower(email));

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  role_code text not null references public.roles (code),
  approval_limit numeric(14, 2) check (approval_limit is null or approval_limit >= 0),
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, role_code)
);
create index user_roles_role_idx on public.user_roles (role_code);

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
create table public.policies (
  id uuid primary key default gen_random_uuid(),
  policy_number text not null unique,
  holder_id uuid not null references public.profiles (id),
  policy_type text not null check (policy_type in ('MOTOR', 'PROPERTY', 'HEALTH', 'TRAVEL', 'LIABILITY')),
  insured_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'LAPSED', 'CANCELLED', 'EXPIRED')),
  effective_from date not null,
  effective_to date not null,
  sum_insured numeric(14, 2) not null check (sum_insured > 0),
  deductible numeric(14, 2) not null default 0 check (deductible >= 0),
  premium numeric(14, 2) not null default 0 check (premium >= 0),
  insured_asset text,
  coverage_summary text,
  payout_bank_name text,
  payout_account_number text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to > effective_from)
);
create index policies_holder_idx on public.policies (holder_id);

-- ---------------------------------------------------------------------------
-- Claims
-- ---------------------------------------------------------------------------
create sequence public.claim_number_seq start 1000;

create table public.claims (
  id uuid primary key default gen_random_uuid(),
  claim_number text unique,
  customer_id uuid not null references public.profiles (id),
  policy_id uuid references public.policies (id),
  claim_type text check (claim_type in ('MOTOR', 'PROPERTY', 'HEALTH', 'TRAVEL', 'LIABILITY')),
  status text not null default 'DRAFT' check (status in (
    'DRAFT', 'SUBMITTED', 'POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW',
    'ADJUSTER_ASSIGNMENT', 'INVESTIGATION', 'RESERVE_APPROVAL', 'COMPLIANCE_REVIEW',
    'SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID', 'CLOSED',
    'REJECTED', 'WITHDRAWN', 'ON_HOLD', 'REOPENED')),
  hold_from_status text,
  priority text not null default 'MEDIUM' check (priority in ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  insured_name text,
  incident_at timestamptz,
  incident_location text,
  incident_category text,
  incident_description text,
  estimated_loss numeric(14, 2) check (estimated_loss is null or estimated_loss >= 0),
  affected_asset text,
  contact_name text,
  contact_phone text,
  contact_email text,
  declaration_accepted boolean not null default false,
  declaration_accepted_at timestamptz,
  draft_step integer not null default 1 check (draft_step between 1 and 6),
  submission_key uuid unique,
  submitted_at timestamptz,
  assigned_owner_id uuid references public.profiles (id),
  assigned_adjuster_id uuid references public.profiles (id),
  assigned_reviewer_id uuid references public.profiles (id),
  due_date timestamptz,
  policy_verified boolean,
  policy_verified_by uuid references public.profiles (id),
  policy_verified_at timestamptz,
  policy_verification_notes text,
  intake_checklist jsonb not null default '{}'::jsonb,
  document_exception_reason text,
  document_exception_by uuid references public.profiles (id),
  document_exception_at timestamptz,
  escalation_level integer not null default 0 check (escalation_level between 0 and 3),
  escalated_at timestamptz,
  escalation_reason text,
  possible_duplicate_of uuid references public.claims (id),
  rejection_reason text,
  closure_reason text,
  closed_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claims_number_required check (status in ('DRAFT', 'WITHDRAWN') or claim_number is not null),
  constraint claims_submission_complete check (
    status in ('DRAFT', 'WITHDRAWN') or (
      policy_id is not null and incident_at is not null and estimated_loss is not null
      and declaration_accepted and submitted_at is not null)),
  constraint claims_hold_origin check (status <> 'ON_HOLD' or hold_from_status is not null)
);
create index claims_customer_idx on public.claims (customer_id);
create index claims_policy_idx on public.claims (policy_id);
create index claims_status_idx on public.claims (status);
create index claims_owner_idx on public.claims (assigned_owner_id);
create index claims_adjuster_idx on public.claims (assigned_adjuster_id);
create index claims_submitted_idx on public.claims (submitted_at desc);
create index claims_duplicate_check_idx on public.claims (policy_id, incident_category, incident_at);

create table public.claim_assignments (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  assignee_id uuid not null references public.profiles (id),
  assignment_role text not null check (assignment_role in ('OPERATIONS_OWNER', 'DOCUMENT_REVIEWER', 'ADJUSTER')),
  assigned_by uuid references public.profiles (id),
  reason text,
  is_active boolean not null default true,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index claim_assignments_one_active on public.claim_assignments (claim_id, assignment_role) where is_active;
create index claim_assignments_assignee_idx on public.claim_assignments (assignee_id, is_active);

create table public.claim_notes (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  author_id uuid not null references public.profiles (id),
  visibility text not null default 'INTERNAL' check (visibility in ('INTERNAL', 'CUSTOMER')),
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index claim_notes_claim_idx on public.claim_notes (claim_id, created_at desc);

create table public.claim_status_history (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_by uuid references public.profiles (id),
  reason text,
  customer_message text,
  customer_visible boolean not null default true,
  created_at timestamptz not null default now()
);
create index claim_status_history_claim_idx on public.claim_status_history (claim_id, created_at);

create table public.information_requests (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  request_type text not null check (request_type in ('DOCUMENT', 'INFORMATION')),
  document_category text,
  message text not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'RESPONDED', 'CLOSED', 'CANCELLED')),
  requested_by uuid not null references public.profiles (id),
  due_at timestamptz,
  response_text text,
  responded_by uuid references public.profiles (id),
  responded_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index information_requests_claim_idx on public.information_requests (claim_id, status);

-- ---------------------------------------------------------------------------
-- Documents (metadata only — files live in the private "claim-documents" bucket)
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  document_group_id uuid not null,
  version_no integer not null default 1 check (version_no >= 1),
  category text not null,
  file_name text not null,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  checksum_sha256 text,
  status text not null default 'PENDING_REVIEW' check (status in ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  uploaded_by uuid not null references public.profiles (id),
  uploaded_at timestamptz not null default now(),
  information_request_id uuid references public.information_requests (id),
  reviewer_id uuid references public.profiles (id),
  review_assigned_at timestamptz,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  review_comment text,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_group_id, version_no),
  check (status <> 'REJECTED' or rejection_reason is not null)
);
create index documents_claim_idx on public.documents (claim_id);
create index documents_status_idx on public.documents (status);

-- ---------------------------------------------------------------------------
-- Tasks
-- ---------------------------------------------------------------------------
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid references public.claims (id) on delete cascade,
  title text not null,
  description text,
  task_type text not null default 'GENERAL',
  status text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED')),
  priority text not null default 'MEDIUM' check (priority in ('LOW', 'MEDIUM', 'HIGH', 'URGENT')),
  is_mandatory boolean not null default false,
  assignee_id uuid references public.profiles (id),
  assigned_role text,
  due_at timestamptz,
  created_by uuid references public.profiles (id),
  completed_by uuid references public.profiles (id),
  completed_at timestamptz,
  overdue_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_claim_idx on public.tasks (claim_id);
create index tasks_assignee_idx on public.tasks (assignee_id, status);
create index tasks_due_idx on public.tasks (due_at) where status in ('OPEN', 'IN_PROGRESS');

-- ---------------------------------------------------------------------------
-- Investigation, reserves, settlements, approvals
-- ---------------------------------------------------------------------------
create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  version_no integer not null default 1,
  adjuster_id uuid not null references public.profiles (id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED', 'SUPERSEDED')),
  checklist jsonb not null default '{}'::jsonb,
  findings text,
  evidence jsonb not null default '[]'::jsonb,
  estimated_loss numeric(14, 2) check (estimated_loss is null or estimated_loss >= 0),
  recommended_settlement numeric(14, 2) check (recommended_settlement is null or recommended_settlement >= 0),
  recommendation text check (recommendation is null or recommendation in ('PAY_FULL', 'PAY_PARTIAL', 'DENY')),
  internal_notes text,
  submitted_at timestamptz,
  reviewed_by uuid references public.profiles (id),
  reviewed_at timestamptz,
  review_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (claim_id, version_no)
);

create table public.reserves (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  assessment_id uuid references public.assessments (id),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'USD',
  reason text,
  status text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED', 'SUPERSEDED')),
  requested_by uuid not null references public.profiles (id),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reserves_claim_idx on public.reserves (claim_id);
create unique index reserves_one_pending on public.reserves (claim_id) where status = 'PENDING_APPROVAL';

create table public.settlements (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  assessment_id uuid references public.assessments (id),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'USD',
  status text not null default 'PENDING_APPROVAL' check (status in ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED')),
  beneficiary_name text not null,
  beneficiary_bank text,
  beneficiary_account text,
  notes text,
  requested_by uuid not null references public.profiles (id),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index settlements_claim_idx on public.settlements (claim_id);
create unique index settlements_one_open on public.settlements (claim_id) where status in ('PENDING_APPROVAL', 'APPROVED');

-- One immutable row per approval decision.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  approval_type text not null check (approval_type in ('RESERVE', 'SETTLEMENT')),
  reserve_id uuid references public.reserves (id),
  settlement_id uuid references public.settlements (id),
  amount numeric(14, 2) not null,
  decision text not null check (decision in ('APPROVED', 'REJECTED', 'RETURNED')),
  requested_by uuid not null references public.profiles (id),
  decided_by uuid not null references public.profiles (id),
  approver_limit numeric(14, 2),
  comments text,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint approvals_no_self_approval check (requested_by <> decided_by),
  constraint approvals_target check (
    (approval_type = 'RESERVE' and reserve_id is not null and settlement_id is null) or
    (approval_type = 'SETTLEMENT' and settlement_id is not null and reserve_id is null)),
  constraint approvals_within_limit check (
    decision <> 'APPROVED' or (approver_limit is not null and amount <= approver_limit))
);
create index approvals_claim_idx on public.approvals (claim_id);
create index approvals_decider_idx on public.approvals (decided_by, decided_at desc);

-- ---------------------------------------------------------------------------
-- Compliance
-- ---------------------------------------------------------------------------
create table public.compliance_reviews (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'IN_REVIEW', 'CLEARED', 'HOLD', 'EXCEPTION_APPROVED', 'ESCALATED')),
  checklist jsonb not null default '{}'::jsonb,
  risk_flags jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  decision_notes text,
  escalation_notes text,
  exception_reason text,
  hold_active boolean not null default false,
  hold_placed_by uuid references public.profiles (id),
  hold_placed_at timestamptz,
  reviewer_id uuid references public.profiles (id),
  decided_by uuid references public.profiles (id),
  decided_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status <> 'EXCEPTION_APPROVED' or exception_reason is not null),
  check (not hold_active or status in ('HOLD', 'ESCALATED'))
);
create index compliance_reviews_claim_idx on public.compliance_reviews (claim_id, created_at desc);
create index compliance_reviews_active_hold_idx on public.compliance_reviews (claim_id) where hold_active;

-- ---------------------------------------------------------------------------
-- Payments (simulated adapter in the MVP — see payments.is_simulated)
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references public.claims (id) on delete cascade,
  settlement_id uuid not null unique references public.settlements (id),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'USD',
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'PAID', 'FAILED', 'RECONCILED', 'CANCELLED')),
  beneficiary_name text not null,
  beneficiary_bank text,
  beneficiary_account text not null,
  provider text not null default 'SIMULATED',
  is_simulated boolean not null default true,
  transaction_reference text unique,
  attempt_count integer not null default 0,
  last_failure_reason text,
  paid_at timestamptz,
  reconciled_at timestamptz,
  reconciled_by uuid references public.profiles (id),
  reconciliation_reference text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_status_idx on public.payments (status);

create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id) on delete cascade,
  attempt_no integer not null,
  idempotency_key text not null unique,
  status text not null default 'PROCESSING' check (status in ('PROCESSING', 'SUCCEEDED', 'FAILED')),
  provider text not null,
  provider_reference text,
  failure_code text,
  failure_reason text,
  initiated_by uuid references public.profiles (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  raw_response jsonb,
  created_at timestamptz not null default now(),
  unique (payment_id, attempt_no)
);

-- ---------------------------------------------------------------------------
-- Notifications & audit
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  claim_id uuid references public.claims (id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  link text,
  is_read boolean not null default false,
  read_at timestamptz,
  email_status text not null default 'NOT_REQUESTED' check (email_status in ('NOT_REQUESTED', 'PENDING', 'LOGGED_DEV', 'SENT', 'FAILED')),
  email_provider_message_id text,
  created_at timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications (recipient_id, is_read, created_at desc);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id),
  actor_roles text[] not null default '{}',
  action text not null,
  entity_type text not null,
  entity_id uuid,
  claim_id uuid references public.claims (id),
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  request_id text,
  ip_address text,
  created_at timestamptz not null default now()
);
create index audit_logs_claim_idx on public.audit_logs (claim_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on public.audit_logs (actor_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
