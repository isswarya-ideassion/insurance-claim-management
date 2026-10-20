import {
  BarChart3,
  BellRing,
  Contact,
  Briefcase,
  ClipboardList,
  FilePlus2,
  FileSearch,
  FileText,
  Gavel,
  History,
  Inbox,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Receipt,
  ScrollText,
  ShieldCheck,
  Scale,
  UserCog,
  Users,
  Wallet,
} from 'lucide-react'
import { ROLES as R } from '@shared/constants.js'

export const ROLE_HOME = {
  CUSTOMER: '/customer',
  CLAIMS_OPERATIONS: '/operations',
  DOCUMENT_REVIEWER: '/document-review',
  CLAIMS_ADJUSTER: '/adjuster',
  CLAIMS_MANAGER: '/manager',
  PAYMENT_OPERATIONS: '/payments',
  COMPLIANCE_OFFICER: '/compliance',
  DATA_ADMIN: '/admin/users',
  AUDITOR: '/audit',
  CUSTOMER_RECORDS_ADMIN: '/customer-records',
}

/** Role-specific navigation; the sidebar shows the active workspace's list. */
export const NAVIGATION = {
  [R.CUSTOMER]: [
    { to: '/customer', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/customer/policies', label: 'My Policies', icon: ShieldCheck },
    { to: '/customer/claims', label: 'My Claims', icon: FileText, end: true },
    { to: '/customer/claims/new', label: 'New Claim', icon: FilePlus2 },
    { to: '/customer/requests', label: 'Information Requests', icon: Inbox },
    { to: '/customer/payments', label: 'Settlements & Payments', icon: Wallet },
  ],
  [R.CLAIMS_OPERATIONS]: [
    { to: '/operations', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/claims', label: 'Claims Queue', icon: ClipboardList },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/automation/reminders', label: 'Reminders', icon: BellRing },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
  ],
  [R.DOCUMENT_REVIEWER]: [
    { to: '/document-review', label: 'Review Queue', icon: FileSearch },
    { to: '/claims', label: 'Claims', icon: ClipboardList },
    { to: '/tasks', label: 'My Tasks', icon: ListChecks },
  ],
  [R.CLAIMS_ADJUSTER]: [
    { to: '/adjuster', label: 'My Assigned Claims', icon: Briefcase },
    { to: '/tasks', label: 'My Tasks', icon: ListChecks },
  ],
  [R.CLAIMS_MANAGER]: [
    { to: '/manager', label: 'Team Workload', icon: LayoutDashboard, end: true },
    { to: '/manager/unassigned', label: 'Unassigned Claims', icon: Users },
    { to: '/manager/reserves', label: 'Reserve Approvals', icon: Scale },
    { to: '/manager/settlements', label: 'Settlement Approvals', icon: Gavel },
    { to: '/manager/decisions', label: 'Decision History', icon: History },
    { to: '/claims', label: 'All Claims', icon: ClipboardList },
    { to: '/compliance', label: 'Compliance Queue', icon: ShieldCheck },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/automation/reminders', label: 'Reminders', icon: BellRing },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
    { to: '/audit', label: 'Audit Log', icon: ScrollText },
  ],
  [R.PAYMENT_OPERATIONS]: [
    { to: '/payments', label: 'Awaiting Payment', icon: Wallet, end: true },
    { to: '/payments/reconciliation', label: 'Reconciliation', icon: Landmark },
    { to: '/payments/history', label: 'Payment History', icon: Receipt },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
  ],
  [R.COMPLIANCE_OFFICER]: [
    { to: '/compliance', label: 'Compliance Queue', icon: ShieldCheck },
    { to: '/claims', label: 'Claims', icon: ClipboardList },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/manager/decisions', label: 'Approval Decisions', icon: History },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
    { to: '/audit', label: 'Audit Log', icon: ScrollText },
  ],
  [R.DATA_ADMIN]: [
    { to: '/admin/users', label: 'Users & Roles', icon: UserCog },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
    { to: '/audit', label: 'Audit Log', icon: ScrollText },
  ],
  [R.AUDITOR]: [
    { to: '/audit', label: 'Audit Log', icon: ScrollText },
    { to: '/claims', label: 'Claims', icon: ClipboardList },
    { to: '/manager/decisions', label: 'Approval Decisions', icon: History },
    { to: '/payments/history', label: 'Payments', icon: Receipt },
    { to: '/reports', label: 'Reports', icon: BarChart3 },
  ],
  [R.CUSTOMER_RECORDS_ADMIN]: [
    { to: '/customer-records', label: 'Customer Records', icon: Contact },
  ],
}

const STAFF = [R.CLAIMS_OPERATIONS, R.DOCUMENT_REVIEWER, R.CLAIMS_ADJUSTER, R.CLAIMS_MANAGER, R.PAYMENT_OPERATIONS, R.COMPLIANCE_OFFICER, R.AUDITOR]

/** Roles allowed on each route. The API enforces the same rules independently. */
export const ROUTE_ROLES = {
  customer: [R.CUSTOMER],
  operations: [R.CLAIMS_OPERATIONS, R.CLAIMS_MANAGER],
  claims: STAFF,
  tasks: [R.CLAIMS_OPERATIONS, R.DOCUMENT_REVIEWER, R.CLAIMS_ADJUSTER, R.CLAIMS_MANAGER, R.PAYMENT_OPERATIONS, R.COMPLIANCE_OFFICER, R.AUDITOR],
  documentReview: [R.DOCUMENT_REVIEWER, R.CLAIMS_MANAGER],
  adjuster: [R.CLAIMS_ADJUSTER],
  manager: [R.CLAIMS_MANAGER, R.AUDITOR],
  decisions: [R.CLAIMS_MANAGER, R.COMPLIANCE_OFFICER, R.AUDITOR],
  compliance: [R.COMPLIANCE_OFFICER, R.CLAIMS_MANAGER, R.AUDITOR],
  payments: [R.PAYMENT_OPERATIONS, R.CLAIMS_MANAGER, R.COMPLIANCE_OFFICER, R.AUDITOR],
  reports: [R.CLAIMS_OPERATIONS, R.CLAIMS_MANAGER, R.COMPLIANCE_OFFICER, R.PAYMENT_OPERATIONS, R.DATA_ADMIN, R.AUDITOR],
  audit: [R.AUDITOR, R.COMPLIANCE_OFFICER, R.CLAIMS_MANAGER, R.DATA_ADMIN],
  admin: [R.DATA_ADMIN],
  customerRecords: [R.CUSTOMER_RECORDS_ADMIN],
  automation: [R.CLAIMS_OPERATIONS, R.CLAIMS_MANAGER, R.AUDITOR],
}
