-- Adjuster settlement authority (October 27, 2026).
--
-- The claim's assigned adjuster approves the settlement when the amount is
-- within their settlement limit (the same as their reserve limit: 15,000
-- personal, 30,000 commercial). Larger settlements go to a Claims Manager.
-- Payment Operators no longer approve settlements; they verify payees, issue
-- and reconcile payments. The approver still cannot issue the payment.

-- 1. Authority: adjusters gain settlement limits; Payment Operator limits end.
insert into public.authority_limits (role, segment, coverage_line, limit_type, max_amount) values
  ('ADJUSTER', 'PERSONAL', '*', 'SETTLEMENT', 15000),
  ('ADJUSTER', 'COMMERCIAL', '*', 'SETTLEMENT', 30000);

update public.authority_limits
   set effective_to = now()
 where role = 'PAYMENT_OPERATOR' and limit_type = 'SETTLEMENT' and effective_to is null;

-- 2. Approval rule. An adjuster step is decided by the claim's assigned
-- adjuster, who also prepared the settlement, so the preparer rule applies to
-- Claims Manager steps only. The authority check applies to both.
create or replace function public.enforce_settlement_step() returns trigger
language plpgsql as $$
declare
  v_payment public.payments%rowtype;
  v_claim public.claims%rowtype;
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
  select * into v_claim from public.claims where id = v_payment.claim_id;
  if new.required_role = 'ADJUSTER' then
    if v_claim.assigned_adjuster_id is distinct from new.approver_id then
      raise exception 'APPROVAL_NOT_AUTHORISED: only the assigned adjuster can approve this settlement' using errcode = 'P0001';
    end if;
  elsif v_payment.requested_by = new.approver_id then
    raise exception 'SELF_APPROVAL_FORBIDDEN: the preparer of a settlement cannot approve it' using errcode = 'P0001';
  end if;
  v_limit := public.effective_limit(new.approver_id, 'SETTLEMENT', v_claim.segment, '*');
  if new.status = 'APPROVED' and (v_limit is null or v_payment.amount > v_limit) then
    raise exception 'APPROVAL_LIMIT_EXCEEDED: % exceeds approval limit %', v_payment.amount, coalesce(v_limit, 0)
      using errcode = 'P0001';
  end if;
  new.approver_limit_at_decision := v_limit;
  new.decided_at := coalesce(new.decided_at, now());
  return new;
end;
$$;

-- 3. Settlements still waiting for a Payment Operator move to the new approver.
update public.settlement_approval_steps s
   set required_role = case
         when p.amount <= coalesce((select al.max_amount from public.authority_limits al
                                     where al.role = 'ADJUSTER' and al.limit_type = 'SETTLEMENT'
                                       and al.segment = c.segment and al.coverage_line = '*'
                                       and al.effective_to is null), 0)
         then 'ADJUSTER' else 'OPS_MANAGER' end
  from public.payments p
  join public.claims c on c.id = p.claim_id
 where p.id = s.payment_id and s.status = 'PENDING' and s.required_role = 'PAYMENT_OPERATOR';

-- 4. Adjusters can read settlements and approval steps on claims they can access.
drop policy if exists payments_read on public.payments;
create policy payments_read on public.payments for select to authenticated
  using (public.has_any_role(array['PAYMENT_OPERATOR', 'OPS_MANAGER', 'ADJUSTER', 'COMPLIANCE_SECURITY'])
         and public.can_access_claim(claim_id));

drop policy if exists settlement_steps_read on public.settlement_approval_steps;
create policy settlement_steps_read on public.settlement_approval_steps for select to authenticated
  using (exists (select 1 from public.payments p
                  where p.id = settlement_approval_steps.payment_id
                    and public.has_any_role(array['PAYMENT_OPERATOR', 'OPS_MANAGER', 'ADJUSTER', 'COMPLIANCE_SECURITY'])
                    and public.can_access_claim(p.claim_id)));
