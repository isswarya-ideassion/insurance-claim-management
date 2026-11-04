-- Organised-fraud detection: shell entities sharing a registered address.
--
-- The pattern this targets: two or more "companies" register at the same
-- co-working or virtual-office address, take policies, and claim. Each claim
-- looks ordinary on its own; the ring is only visible across entities. When an
-- inspector visits, the office does not exist.
--
-- Nothing here decides anything. It produces evidence that feeds the existing
-- claim_fraud_flags / fraud score, which a Compliance user still reviews.

-- ---------------------------------------------------------------------------
-- 1. Registered addresses (the system had no address field for an entity)
-- ---------------------------------------------------------------------------
-- premises_hash is BUILDING level: the unit/suite/floor is deliberately kept
-- out of it, because shell entities at one tower differ only by suite number.
-- Hashing the full address would make them look unrelated.
create table public.entity_premises (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.users (id) on delete cascade,
  policy_id uuid references public.policies (id) on delete set null,
  address_role text not null default 'REGISTERED'
    check (address_role in ('REGISTERED', 'OPERATING', 'CORRESPONDENCE')),
  raw_address text not null,
  -- Canonical building key: sha256(pincode | sorted normalised tokens).
  premises_hash text not null,
  -- Suite / unit / floor / desk, parsed out of the raw address.
  unit_label text,
  pincode text,
  city_normalized text,
  -- Set when the address matches a known co-working or virtual-office brand.
  workspace_provider text,
  is_shared_workspace boolean not null default false,
  -- Company identifier (CIN / GSTIN / registration no.) when supplied.
  registration_no text,
  created_by uuid references public.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index entity_premises_hash_idx on public.entity_premises (premises_hash);
create index entity_premises_entity_idx on public.entity_premises (entity_id);
create index entity_premises_registration_idx on public.entity_premises (registration_no)
  where registration_no is not null;

-- ---------------------------------------------------------------------------
-- 2. Physical verification (the "we visited and it isn't there" fact)
-- ---------------------------------------------------------------------------
create table public.premises_verifications (
  id uuid primary key default gen_random_uuid(),
  entity_premises_id uuid not null references public.entity_premises (id) on delete cascade,
  claim_id uuid references public.claims (id) on delete set null,
  outcome text not null check (outcome in
    ('CONFIRMED', 'NOT_FOUND', 'NO_SIGNAGE', 'OCCUPANT_DENIES', 'ACCESS_REFUSED', 'VACANT', 'MAIL_DROP_ONLY')),
  visited_at timestamptz not null,
  notes text,
  evidence_doc_id uuid references public.documents (id) on delete set null,
  verified_by uuid not null references public.users (id),
  created_at timestamptz not null default now()
);
create index premises_verifications_premises_idx
  on public.premises_verifications (entity_premises_id, visited_at desc);

-- ---------------------------------------------------------------------------
-- 3. Detected rings (cache of the graph pass, rebuilt by the nightly job)
-- ---------------------------------------------------------------------------
create table public.fraud_rings (
  id uuid primary key default gen_random_uuid(),
  -- Stable key for the connected component, so a ring keeps its identity.
  ring_key text not null unique,
  link_basis text[] not null default '{}',
  entity_count integer not null default 0,
  claim_count integer not null default 0,
  score integer not null default 0 check (score between 0 and 100),
  band text not null default 'LOW' check (band in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  signals jsonb not null default '[]'::jsonb,
  status text not null default 'OPEN' check (status in ('OPEN', 'INVESTIGATING', 'CONFIRMED', 'DISMISSED')),
  reviewed_by uuid references public.users (id),
  reviewed_at timestamptz,
  review_note text,
  first_detected_at timestamptz not null default now(),
  last_evaluated_at timestamptz not null default now()
);
create index fraud_rings_score_idx on public.fraud_rings (score desc) where status = 'OPEN';

create table public.fraud_ring_members (
  ring_id uuid not null references public.fraud_rings (id) on delete cascade,
  entity_id uuid not null references public.users (id) on delete cascade,
  premises_hash text,
  claim_ids uuid[] not null default '{}',
  joined_at timestamptz not null default now(),
  primary key (ring_id, entity_id)
);

-- ---------------------------------------------------------------------------
-- 4. Reason codes for the existing fraud score
-- ---------------------------------------------------------------------------
-- Weights are multiplied by SEVERITY_FACTOR (HIGH 1 / MEDIUM 0.6 / LOW 0.3) in
-- compliance.service.js, exactly like the codes already present.
--
-- SHARED_REGISTERED_ADDRESS is deliberately LOW weight: real companies share
-- co-working addresses every day. It is corroboration, not evidence. The heavy
-- weights sit on facts that are hard to explain away — a visit that found no
-- office, or two "unrelated" entities banking to one account.
insert into public.fraud_reason_codes (code, description, category, weight, active) values
  ('SHARED_REGISTERED_ADDRESS', 'Registered address is shared with other claiming entities', 'PATTERN', 15, true),
  ('VIRTUAL_OFFICE_ADDRESS',    'Registered address is a co-working or virtual-office facility', 'PATTERN', 10, true),
  ('PREMISES_NOT_FOUND',        'Site visit could not find the insured premises', 'EVIDENCE', 55, true),
  ('SHARED_BANK_ACCOUNT',       'Bank account is shared with another claiming entity', 'PATTERN', 50, true),
  ('RAPID_CLAIM_AFTER_INCEPTION', 'Loss occurred soon after the policy incepted', 'TIMING', 25, true),
  ('CORRELATED_RING_TIMING',    'Claims from entities at one address cluster in time', 'TIMING', 30, true),
  ('NO_TRADING_HISTORY',        'Entity has no prior policy or claim history', 'BEHAVIOUR', 10, true)
on conflict (code) do nothing;
