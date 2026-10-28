-- Claims portal enhancements (October 27, 2026).
--
-- 1. Loss location is captured as address plus separate city and country.
-- 2. Amounts are in Indian rupees: currency defaults and existing rows become INR.
--    Only the currency code changes; amounts are not converted.
-- 3. Rejection notifications get their own templates so the UI can mark them.
-- 4. Customers can request a policy renewal; a Claims Operations Manager
--    completes (extends the policy) or declines it.

-- 1. Loss city and country
alter table public.claims
  add column loss_city text,
  add column loss_country text;

-- 2. Currency
alter table public.payments alter column currency set default 'INR';
alter table public.reserves alter column currency set default 'INR';
alter table public.recoveries alter column currency set default 'INR';
alter table public.authority_limits alter column currency set default 'INR';
alter table public.user_attributes alter column currency set default 'INR';

update public.payments set currency = 'INR' where currency <> 'INR';
update public.reserves set currency = 'INR' where currency <> 'INR';
update public.recoveries set currency = 'INR' where currency <> 'INR';
update public.authority_limits set currency = 'INR' where currency <> 'INR';
update public.user_attributes set currency = 'INR' where currency <> 'INR';

-- 3. Rejection notifications already sent
update public.notifications set template = 'CLAIM_REJECTED'
 where template = 'CLAIM_STATUS_CHANGED' and title like '%: Not approved';
update public.notifications set template = 'APPROVAL_REJECTED'
 where template = 'APPROVAL_DECISION' and title ~* '^(settlement|reserve|closure) rejected:';

-- 4. Policy renewal requests
create table public.policy_renewal_requests (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.policies (id) on delete cascade,
  requested_by uuid not null references public.users (id),
  requested_at timestamptz not null default now(),
  term_months integer not null default 12 check (term_months between 1 and 36),
  notes text,
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'COMPLETED', 'DECLINED', 'CANCELLED')),
  decided_by uuid references public.users (id),
  decided_at timestamptz,
  decision_reason text,
  previous_expiry date,
  new_expiry date,
  task_id uuid references public.tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  check (decided_by is null or decided_by <> requested_by),
  check (status in ('REQUESTED', 'CANCELLED') or (decided_by is not null and decided_at is not null)),
  check (status <> 'COMPLETED' or (previous_expiry is not null and new_expiry > previous_expiry)),
  check (status <> 'DECLINED' or coalesce(btrim(decision_reason), '') <> '')
);
create unique index policy_renewal_requests_one_open on public.policy_renewal_requests (policy_id) where status = 'REQUESTED';
create index policy_renewal_requests_policy_idx on public.policy_renewal_requests (policy_id);

create trigger policy_renewal_requests_set_updated_at before update on public.policy_renewal_requests
  for each row execute function public.set_updated_at();
create trigger policy_renewal_requests_bump_version before update on public.policy_renewal_requests
  for each row execute function public.bump_version();

alter table public.policy_renewal_requests enable row level security;
grant select on public.policy_renewal_requests to authenticated;
create policy policy_renewal_requests_read on public.policy_renewal_requests for select to authenticated
  using (requested_by = auth.uid()
         or exists (select 1 from public.policies p where p.id = policy_id and p.insured_id = auth.uid())
         or public.has_any_role(array['CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'COMPLIANCE_SECURITY']));
