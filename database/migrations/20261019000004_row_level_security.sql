-- Row-level security. The Express API connects with a privileged role and
-- enforces authorization in its service layer; these policies are the
-- database-level boundary for any access made with a user's JWT
-- (anon / authenticated roles through PostgREST or supabase-js).

-- ---------------------------------------------------------------------------
-- Helper functions (security definer so they can read role tables under RLS)
-- ---------------------------------------------------------------------------
create or replace function public.has_role(p_role text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid() and ur.role_code = p_role and p.is_active
  )
$$;

create or replace function public.has_any_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.user_roles ur
    join public.profiles p on p.id = ur.user_id
    where ur.user_id = auth.uid() and ur.role_code = any (p_roles) and p.is_active
  )
$$;

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_any_role(array['CLAIMS_OPERATIONS', 'DOCUMENT_REVIEWER', 'CLAIMS_ADJUSTER',
    'CLAIMS_MANAGER', 'PAYMENT_OPERATIONS', 'COMPLIANCE_OFFICER', 'DATA_ADMIN', 'AUDITOR'])
$$;

-- Mirrors server/src/services/access.service.js (claim scope rules).
create or replace function public.can_access_claim(p_claim_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.claims c
    where c.id = p_claim_id and (
      c.customer_id = auth.uid()
      or (c.status = 'DRAFT' and c.created_by = auth.uid())
      or (c.status <> 'DRAFT' and (
        public.has_any_role(array['CLAIMS_OPERATIONS', 'CLAIMS_MANAGER', 'AUDITOR'])
        or (public.has_role('DOCUMENT_REVIEWER') and (
              c.status in ('POLICY_VERIFICATION', 'DOCUMENTS_REQUIRED', 'DOCUMENT_REVIEW')
              or c.assigned_reviewer_id = auth.uid()))
        or (public.has_role('CLAIMS_ADJUSTER') and exists (
              select 1 from public.claim_assignments a
              where a.claim_id = c.id and a.assignee_id = auth.uid() and a.assignment_role = 'ADJUSTER'))
        or (public.has_role('COMPLIANCE_OFFICER') and (
              c.status in ('COMPLIANCE_REVIEW', 'SETTLEMENT_APPROVAL', 'ON_HOLD')
              or exists (select 1 from public.compliance_reviews r where r.claim_id = c.id)))
        or (public.has_role('PAYMENT_OPERATIONS') and (
              c.status in ('PAYMENT_PENDING', 'PAYMENT_FAILED', 'PAID')
              or exists (select 1 from public.payments pm where pm.claim_id = c.id)))
      ))
    )
  )
$$;

create or replace function public.can_staff_access_claim(p_claim_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() and public.can_access_claim(p_claim_id)
$$;

-- ---------------------------------------------------------------------------
-- Privileges: deny anon entirely; authenticated gets read access subject to RLS
-- and narrowly scoped write access.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on all tables in schema public to authenticated;
grant insert, update on public.claims to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
grant update (is_read, read_at) on public.notifications to authenticated;
grant insert, update, delete on public.user_roles to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['roles', 'profiles', 'user_roles', 'policies', 'claims', 'claim_assignments',
    'claim_notes', 'claim_status_history', 'information_requests', 'documents', 'tasks', 'assessments',
    'reserves', 'settlements', 'approvals', 'compliance_reviews', 'payments', 'payment_attempts',
    'notifications', 'audit_logs', 'claim_status_transitions']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end;
$$;

-- Reference data
create policy roles_read on public.roles for select to authenticated using (true);
create policy transitions_read on public.claim_status_transitions for select to authenticated using (true);

-- Profiles
create policy profiles_read on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_staff());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- User roles: users see their own roles; only DATA_ADMIN may change roles and
-- never their own (prevents self-escalation).
create policy user_roles_read on public.user_roles for select to authenticated
  using (user_id = auth.uid() or public.has_any_role(array['DATA_ADMIN', 'AUDITOR']));
create policy user_roles_admin_insert on public.user_roles for insert to authenticated
  with check (public.has_role('DATA_ADMIN') and user_id <> auth.uid());
create policy user_roles_admin_update on public.user_roles for update to authenticated
  using (public.has_role('DATA_ADMIN') and user_id <> auth.uid())
  with check (public.has_role('DATA_ADMIN') and user_id <> auth.uid());
create policy user_roles_admin_delete on public.user_roles for delete to authenticated
  using (public.has_role('DATA_ADMIN') and user_id <> auth.uid());

-- Policies (insurance contracts)
create policy policies_read on public.policies for select to authenticated
  using (holder_id = auth.uid() or public.has_any_role(array['CLAIMS_OPERATIONS', 'CLAIMS_MANAGER',
    'DOCUMENT_REVIEWER', 'CLAIMS_ADJUSTER', 'COMPLIANCE_OFFICER', 'AUDITOR']));

-- Claims: customers may create and edit only their own drafts.
-- Ownership columns are checked directly so a customer's INSERT ... RETURNING
-- succeeds (the helper function cannot see a row inserted by the same statement).
create policy claims_read on public.claims for select to authenticated
  using (customer_id = auth.uid() or (status = 'DRAFT' and created_by = auth.uid()) or public.can_access_claim(id));
create policy claims_customer_insert_draft on public.claims for insert to authenticated
  with check (customer_id = auth.uid() and status = 'DRAFT' and public.has_role('CUSTOMER'));
create policy claims_customer_update_draft on public.claims for update to authenticated
  using (customer_id = auth.uid() and status = 'DRAFT')
  with check (customer_id = auth.uid() and status = 'DRAFT');

-- Claim children
create policy claim_assignments_read on public.claim_assignments for select to authenticated
  using (public.can_staff_access_claim(claim_id));
create policy claim_notes_read on public.claim_notes for select to authenticated
  using (public.can_access_claim(claim_id) and (visibility = 'CUSTOMER' or public.is_staff()));
create policy claim_status_history_read on public.claim_status_history for select to authenticated
  using (public.can_access_claim(claim_id) and (customer_visible or public.is_staff()));
create policy information_requests_read on public.information_requests for select to authenticated
  using (public.can_access_claim(claim_id));
create policy documents_read on public.documents for select to authenticated
  using (public.can_access_claim(claim_id));
create policy tasks_read on public.tasks for select to authenticated
  using (public.is_staff() and (assignee_id = auth.uid() or created_by = auth.uid()
    or (claim_id is not null and public.can_access_claim(claim_id))));

create policy assessments_read on public.assessments for select to authenticated
  using (public.has_any_role(array['CLAIMS_OPERATIONS', 'CLAIMS_MANAGER', 'CLAIMS_ADJUSTER', 'COMPLIANCE_OFFICER', 'AUDITOR'])
    and public.can_access_claim(claim_id));
create policy reserves_read on public.reserves for select to authenticated
  using (public.has_any_role(array['CLAIMS_MANAGER', 'CLAIMS_ADJUSTER', 'COMPLIANCE_OFFICER', 'AUDITOR'])
    and public.can_access_claim(claim_id));
create policy settlements_read on public.settlements for select to authenticated
  using (public.has_any_role(array['CLAIMS_MANAGER', 'CLAIMS_ADJUSTER', 'COMPLIANCE_OFFICER', 'PAYMENT_OPERATIONS', 'AUDITOR'])
    and public.can_access_claim(claim_id));
create policy approvals_read on public.approvals for select to authenticated
  using (public.has_any_role(array['CLAIMS_MANAGER', 'CLAIMS_ADJUSTER', 'COMPLIANCE_OFFICER', 'PAYMENT_OPERATIONS', 'AUDITOR'])
    and public.can_access_claim(claim_id));
create policy compliance_reviews_read on public.compliance_reviews for select to authenticated
  using (public.has_any_role(array['COMPLIANCE_OFFICER', 'CLAIMS_MANAGER', 'AUDITOR'])
    and public.can_access_claim(claim_id));
create policy payments_read on public.payments for select to authenticated
  using (public.has_any_role(array['PAYMENT_OPERATIONS', 'CLAIMS_MANAGER', 'COMPLIANCE_OFFICER', 'AUDITOR'])
    and public.can_access_claim(claim_id));
create policy payment_attempts_read on public.payment_attempts for select to authenticated
  using (public.has_any_role(array['PAYMENT_OPERATIONS', 'CLAIMS_MANAGER', 'AUDITOR']));

-- Notifications: recipients only.
create policy notifications_read on public.notifications for select to authenticated
  using (recipient_id = auth.uid());
create policy notifications_mark_read on public.notifications for update to authenticated
  using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

-- Audit log: restricted readers, no client writes at all.
create policy audit_logs_read on public.audit_logs for select to authenticated
  using (public.has_any_role(array['AUDITOR', 'COMPLIANCE_OFFICER', 'CLAIMS_MANAGER', 'DATA_ADMIN']));
