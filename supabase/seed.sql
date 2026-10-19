-- Reference data only. This file never creates authentication identities or
-- profiles: those must come from real Supabase Auth users. To create demo users
-- for every role plus demo claims, run the development provisioning script:
--
--   npm run provision:dev      (see docs/SETUP.md)

insert into public.roles (code, name, description, is_staff) values
  ('CUSTOMER', 'Customer', 'Policyholder submitting and tracking their own claims', false),
  ('CLAIMS_OPERATIONS', 'Claims Operations', 'Intake, policy verification, assignment and claim coordination', true),
  ('DOCUMENT_REVIEWER', 'Document Reviewer', 'Reviews and accepts or rejects claim documents', true),
  ('CLAIMS_ADJUSTER', 'Claims Adjuster', 'Investigates assigned claims and submits loss assessments', true),
  ('CLAIMS_MANAGER', 'Claims Manager', 'Assigns adjusters and approves reserves and settlements within limits', true),
  ('PAYMENT_OPERATIONS', 'Payment Operations', 'Processes approved settlement payments and reconciliation', true),
  ('COMPLIANCE_OFFICER', 'Compliance Officer', 'Performs compliance reviews, holds and clearances', true),
  ('DATA_ADMIN', 'Data Administrator', 'Manages users, role grants and reference data', true),
  ('AUDITOR', 'Auditor', 'Read-only access to claims, decisions and audit history', true)
on conflict (code) do update
  set name = excluded.name, description = excluded.description, is_staff = excluded.is_staff;
