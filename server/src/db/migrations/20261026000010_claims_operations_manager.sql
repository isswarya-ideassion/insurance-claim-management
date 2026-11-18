-- Claims Operations Manager role (October 26, 2026).
--
-- New claims are assigned directly to a Claims Operations Manager, who handles
-- intake, coverage verification, routing and the collection and verification
-- of payee details. The former OPS_MANAGER role becomes the Claims Manager,
-- which keeps approvals, denials, closure and reopening. No existing grants
-- change: Compliance & Security grants the new role to the right people.

insert into public.roles (code, name, description, is_staff) values
  ('CLAIMS_OPS_MANAGER', 'Claims Operations Manager',
   'Owns new claims: intake, coverage verification, routing, adjuster assignment and payee details', true)
on conflict (code) do update
  set name = excluded.name, description = excluded.description, is_staff = excluded.is_staff;

update public.roles
   set name = 'Claims Manager',
       description = 'Reserve reviews above adjuster authority, high-value settlement approval, denials, document exceptions, closure and reopening'
 where code = 'OPS_MANAGER';

-- Staff checks and the claim scope include the new role (full scope, like the Claims Manager).
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_any_role(array['CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'ADJUSTER', 'DOCUMENT_REVIEWER', 'PAYMENT_OPERATOR',
    'DATA_ENGINEER', 'COMPLIANCE_SECURITY'])
$$;

create or replace function public.can_access_claim(p_claim_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.claims c
    where c.id = p_claim_id and (
      c.customer_id = auth.uid()
      or (c.status = 'DRAFT' and c.created_by = auth.uid())
      or (c.status <> 'DRAFT' and (
        public.has_any_role(array['CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'COMPLIANCE_SECURITY'])
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

-- Read access the new role needs for intake: policies, payees (to collect and
-- verify bank details), AI extraction runs and reminders on claims in scope.
drop policy if exists policies_read on public.policies;
create policy policies_read on public.policies for select to authenticated
  using (insured_id = auth.uid() or public.has_any_role(array['CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'DOCUMENT_REVIEWER', 'ADJUSTER',
    'PAYMENT_OPERATOR', 'DATA_ENGINEER', 'COMPLIANCE_SECURITY']));

drop policy if exists payees_read on public.payees;
create policy payees_read on public.payees for select to authenticated
  using (customer_id = auth.uid() or public.has_any_role(array['CLAIMS_OPS_MANAGER', 'PAYMENT_OPERATOR', 'OPS_MANAGER', 'COMPLIANCE_SECURITY']));

drop policy if exists ai_runs_read on public.ai_runs;
create policy ai_runs_read on public.ai_runs for select to authenticated
  using (public.has_any_role(array['CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'DOCUMENT_REVIEWER', 'COMPLIANCE_SECURITY', 'ADJUSTER'])
    and public.can_access_claim(claim_id));

drop policy if exists claim_reminders_read on public.claim_reminders;
create policy claim_reminders_read on public.claim_reminders for select to authenticated
  using ((audience = 'INTERNAL' and recipient_id = auth.uid())
    or (public.has_any_role(array['CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'DOCUMENT_REVIEWER', 'COMPLIANCE_SECURITY'])
        and public.can_access_claim(claim_id)));

-- Open intake and assignment work moves from the Claims Manager queue to the new role's queue.
update public.tasks
   set owner_role = 'CLAIMS_OPS_MANAGER'
 where owner_role = 'OPS_MANAGER'
   and type in ('INTAKE_REVIEW', 'POLICY_CHECK', 'ASSIGN_ADJUSTER')
   and status in ('OPEN', 'IN_PROGRESS');
