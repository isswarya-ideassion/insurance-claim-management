-- Claim agents (October 28, 2026).
--
-- Six advisory agents from PRD section 3 record their runs in ai_runs:
-- coverage-checker, triage-router, reserve-recommender, denial-letter-drafter,
-- payee-anomaly and subrogation-assessor. A person applies or discards each
-- suggestion. Records created from a suggestion point back to the run
-- (coverage_results, reserves and claim_fraud_flags already have ai_run_ref).

-- Recoveries created from a subrogation assessment keep a reference to the run.
alter table public.recoveries add column ai_run_ref uuid;

-- A reviewed decision stays final. The one exception: an accepted run may gain
-- applied parts (triage is applied in parts by different roles: classification
-- and routing by operations, fraud flags by compliance). Parts are only added;
-- the decision, decider and decision time cannot change.
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
    if old.human_decision = 'ACCEPTED' and new.human_decision = 'ACCEPTED'
       and new.decided_by is not distinct from old.decided_by and new.decided_at is not distinct from old.decided_at
       and coalesce(new.applied_fields, '{}') @> coalesce(old.applied_fields, '{}') then
      return new;
    end if;
    raise exception 'ALREADY_REVIEWED: this AI result has already been reviewed' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- Payment Operators run the payee anomaly check, so they can read runs on claims they can access.
drop policy if exists ai_runs_read on public.ai_runs;
create policy ai_runs_read on public.ai_runs for select to authenticated
  using (public.has_any_role(array['CLAIMS_OPS_MANAGER', 'OPS_MANAGER', 'DOCUMENT_REVIEWER', 'COMPLIANCE_SECURITY', 'ADJUSTER', 'PAYMENT_OPERATOR'])
    and public.can_access_claim(claim_id));
