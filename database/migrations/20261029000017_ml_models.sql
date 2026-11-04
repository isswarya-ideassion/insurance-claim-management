-- Models trained from our own claim history, stored as data rather than files.
--
-- Keeping the trained model in Postgres means a serverless function can load it
-- on a cold start with no object storage and no model server, and that every
-- score can be traced to the exact model version that produced it.

create table public.ml_models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version integer not null,
  algorithm text not null,
  -- Serialised trees plus the population statistics the features were scaled
  -- with. Both must travel together: scoring with mismatched statistics is
  -- silently wrong rather than an error.
  payload jsonb not null,
  feature_names text[] not null,
  trained_on integer not null check (trained_on >= 0),
  metrics jsonb not null default '{}'::jsonb,
  trained_at timestamptz not null default now(),
  trained_by uuid references public.users (id),
  active boolean not null default false,
  unique (name, version)
);
-- Exactly one active model per name, enforced rather than assumed.
create unique index ml_models_one_active on public.ml_models (name) where active;

create table public.claim_anomaly_scores (
  claim_id uuid primary key references public.claims (id) on delete cascade,
  model_id uuid not null references public.ml_models (id) on delete cascade,
  score numeric(6, 5) not null check (score >= 0 and score <= 1),
  band text not null check (band in ('TYPICAL', 'ELEVATED', 'UNUSUAL', 'EXTREME')),
  -- Which features pushed the score up, so a reviewer never sees a bare number.
  top_factors jsonb not null default '[]'::jsonb,
  scored_at timestamptz not null default now()
);
create index claim_anomaly_scores_rank_idx on public.claim_anomaly_scores (score desc);
