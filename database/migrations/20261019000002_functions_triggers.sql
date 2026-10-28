-- Functions and triggers that enforce critical invariants inside the database,
-- independently of the API layer.

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['profiles', 'policies', 'claims', 'information_requests', 'documents', 'tasks',
                           'assessments', 'reserves', 'settlements', 'compliance_reviews', 'payments']
  loop
    execute format('create trigger %I_set_updated_at before update on public.%I
                    for each row execute function public.set_updated_at()', t, t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Seed-mode switch: development provisioning sets app.seed_mode = 'on' for its
-- own transaction so it can insert historical records at later workflow stages.
-- ---------------------------------------------------------------------------
create or replace function public.is_seed_mode() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.seed_mode', true), '') = 'on'
$$;

-- ---------------------------------------------------------------------------
-- Profile provisioning for new authentication users.
-- Self-registered users receive only the CUSTOMER role. Staff accounts are
-- created by an administrator with app_metadata.provisioned_staff = true
-- (app_metadata cannot be modified by end users) and receive roles explicitly.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, phone)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;

  if coalesce(new.raw_app_meta_data ->> 'provisioned_staff', 'false') <> 'true' then
    insert into public.user_roles (user_id, role_code)
    values (new.id, 'CUSTOMER')
    on conflict (user_id, role_code) do nothing;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Claim references: HPC-<year>-<6 digit sequence>
-- ---------------------------------------------------------------------------
create or replace function public.next_claim_number() returns text
language sql volatile as $$
  select 'HPC-' || to_char(now() at time zone 'utc', 'YYYY') || '-' ||
         lpad(nextval('public.claim_number_seq')::text, 6, '0')
$$;

-- ---------------------------------------------------------------------------
-- Claim status transitions are validated against public.claim_status_transitions
-- (populated from shared/workflow.js in a later migration).
-- ---------------------------------------------------------------------------
create table public.claim_status_transitions (
  from_status text not null,
  to_status text not null,
  allowed_roles text[] not null,
  requires_reason boolean not null default false,
  system_only boolean not null default false,
  primary key (from_status, to_status)
);

create or replace function public.enforce_claim_status_rules() returns trigger
language plpgsql as $$
begin
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

    if new.status in ('SETTLEMENT_APPROVAL', 'PAYMENT_PENDING', 'PAID') and exists (
      select 1 from public.compliance_reviews where claim_id = new.id and hold_active
    ) then
      raise exception 'COMPLIANCE_HOLD_ACTIVE: claim % has an active compliance hold', new.id
        using errcode = 'P0001';
    end if;

    if new.status = 'PAYMENT_PENDING' and old.status = 'SETTLEMENT_APPROVAL' and not exists (
      select 1 from public.settlements where claim_id = new.id and status = 'APPROVED'
    ) then
      raise exception 'SETTLEMENT_NOT_APPROVED: claim % has no approved settlement', new.id
        using errcode = 'P0001';
    end if;

    if new.status = 'CLOSED' and old.status = 'PAID' and exists (
      select 1 from public.tasks
      where claim_id = new.id and is_mandatory and status in ('OPEN', 'IN_PROGRESS')
    ) then
      raise exception 'OPEN_MANDATORY_TASKS: claim % has open mandatory tasks', new.id
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger claims_enforce_status_rules
  before insert or update on public.claims
  for each row execute function public.enforce_claim_status_rules();

-- ---------------------------------------------------------------------------
-- Approvals: the decider must hold CLAIMS_MANAGER and act within their limit.
-- (Self-approval and limit checks are also table CHECK constraints.)
-- ---------------------------------------------------------------------------
create or replace function public.enforce_approval_authority() returns trigger
language plpgsql as $$
declare
  v_limit numeric(14, 2);
begin
  select approval_limit into v_limit
  from public.user_roles
  where user_id = new.decided_by and role_code = 'CLAIMS_MANAGER';

  if not found then
    raise exception 'APPROVAL_NOT_AUTHORISED: decider does not hold CLAIMS_MANAGER' using errcode = 'P0001';
  end if;

  if new.decision = 'APPROVED' and (v_limit is null or new.amount > v_limit) then
    raise exception 'APPROVAL_LIMIT_EXCEEDED: % exceeds approval limit %', new.amount, coalesce(v_limit, 0)
      using errcode = 'P0001';
  end if;
  new.approver_limit := v_limit;
  return new;
end;
$$;

create trigger approvals_enforce_authority
  before insert on public.approvals
  for each row execute function public.enforce_approval_authority();

-- ---------------------------------------------------------------------------
-- Payments: require an approved settlement and follow a strict state machine.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_payment_rules() returns trigger
language plpgsql as $$
declare
  v_settlement public.settlements%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into v_settlement from public.settlements where id = new.settlement_id;
    if v_settlement.status is distinct from 'APPROVED' then
      raise exception 'SETTLEMENT_NOT_APPROVED: payments require an approved settlement' using errcode = 'P0001';
    end if;
    if new.amount <> v_settlement.amount then
      raise exception 'PAYMENT_AMOUNT_MISMATCH: payment amount must equal the approved settlement' using errcode = 'P0001';
    end if;
    if new.status <> 'PENDING' and not public.is_seed_mode() then
      raise exception 'INVALID_PAYMENT_STATE: payments must be created as PENDING' using errcode = 'P0001';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'PENDING' and new.status in ('PROCESSING', 'CANCELLED')) or
      (old.status = 'PROCESSING' and new.status in ('PAID', 'FAILED')) or
      (old.status = 'FAILED' and new.status in ('PENDING', 'CANCELLED')) or
      (old.status = 'PAID' and new.status = 'RECONCILED')
    ) then
      raise exception 'INVALID_PAYMENT_TRANSITION: % -> %', old.status, new.status using errcode = 'P0001';
    end if;

    if new.status = 'PROCESSING' and exists (
      select 1 from public.compliance_reviews where claim_id = new.claim_id and hold_active
    ) then
      raise exception 'COMPLIANCE_HOLD_ACTIVE: payment blocked by compliance hold' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger payments_enforce_rules
  before insert or update on public.payments
  for each row execute function public.enforce_payment_rules();

-- ---------------------------------------------------------------------------
-- Append-only records
-- ---------------------------------------------------------------------------
create or replace function public.prevent_modification() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_RECORD: % rows cannot be modified or deleted', tg_table_name using errcode = 'P0001';
end;
$$;

create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.prevent_modification();
create trigger approvals_immutable before update or delete on public.approvals
  for each row execute function public.prevent_modification();
create trigger claim_status_history_immutable before update or delete on public.claim_status_history
  for each row execute function public.prevent_modification();

create or replace function public.enforce_payment_attempt_finality() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.status <> 'PROCESSING' then
    raise exception 'IMMUTABLE_RECORD: completed payment attempts cannot be modified' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger payment_attempts_finality before update or delete on public.payment_attempts
  for each row execute function public.enforce_payment_attempt_finality();
