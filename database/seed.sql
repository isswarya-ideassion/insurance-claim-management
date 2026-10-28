-- Reference data only, applied after the migrations on every start (idempotent).
-- It never creates users: accounts are created through the API's sign-in
-- (registration, Users & roles, or the demo seed). For demo users and claims:
--
--   npm run db:seed-demo       (development only; see docs/SETUP.md)
--
-- The eight roles follow the PRD (section 2) plus the Claims Operations Manager
-- (migration 20261026000010). Segment configuration, authority
-- limits, fraud reason codes and source precedence are seeded by migration
-- 20261022000007_prd_schema.sql.

insert into public.roles (code, name, description, is_staff) values
  ('CLIENT', 'Client / Policyholder', 'Files claims, uploads artifacts and tracks their own claims', false),
  ('CLAIMS_OPS_MANAGER', 'Claims Operations Manager', 'Owns new claims: intake, coverage verification, routing, adjuster assignment and payee details', true),
  ('OPS_MANAGER', 'Claims Manager', 'Reserve reviews above adjuster authority, high-value settlement approval, denials, document exceptions, closure and reopening', true),
  ('ADJUSTER', 'Adjuster', 'Investigates assigned claims, evaluates loss, sets reserves and approves settlements within authority, requests closure', true),
  ('DOCUMENT_REVIEWER', 'Document Review Team', 'Validates document completeness and requests missing artifacts', true),
  ('PAYMENT_OPERATOR', 'Payment Operator', 'Verifies payees, issues and reconciles payments', true),
  ('DATA_ENGINEER', 'Data Engineer', 'Operates integration pipelines, source precedence and reconciliation', true),
  ('COMPLIANCE_SECURITY', 'Compliance & Security', 'Compliance reviews, fraud governance, audit, access administration and customer records', true)
on conflict (code) do update
  set name = excluded.name, description = excluded.description, is_staff = excluded.is_staff;
