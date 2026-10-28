import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@/layouts/AppShell.js'
import { AuthLayout } from '@/layouts/AuthLayout.js'
import { ROUTE_ROLES as RR } from '@/constants/navigation.js'
import { FullPageLoader, ProtectedRoute, PublicOnlyRoute, RoleHomeRedirect } from './guards.js'

const page = (loader) => lazy(loader)

const LoginPage = page(() => import('@/pages/auth/LoginPage.js'))
const RegisterPage = page(() => import('@/pages/auth/RegisterPage.js'))
const ForgotPasswordPage = page(() => import('@/pages/auth/ForgotPasswordPage.js'))
const ResetPasswordPage = page(() => import('@/pages/auth/ResetPasswordPage.js'))

const CustomerDashboard = page(() => import('@/pages/customer/CustomerDashboard.js'))
const MyPoliciesPage = page(() => import('@/pages/customer/MyPoliciesPage.js'))
const MyClaimsPage = page(() => import('@/pages/customer/MyClaimsPage.js'))
const NewClaimPage = page(() => import('@/pages/customer/NewClaimPage.js'))
const CustomerClaimDetailPage = page(() => import('@/pages/customer/CustomerClaimDetailPage.js'))
const RequestsPage = page(() => import('@/pages/customer/RequestsPage.js'))
const CustomerPaymentsPage = page(() => import('@/pages/customer/CustomerPaymentsPage.js'))

const OperationsDashboard = page(() => import('@/pages/operations/OperationsDashboard.js'))
const ClaimsQueuePage = page(() => import('@/pages/operations/ClaimsQueuePage.js'))
const ClaimDetailPage = page(() => import('@/pages/operations/ClaimDetailPage.js'))
const TasksPage = page(() => import('@/pages/operations/TasksPage.js'))
const PolicyRenewalsPage = page(() => import('@/pages/operations/PolicyRenewalsPage.js'))
const ReviewQueuePage = page(() => import('@/pages/document-review/ReviewQueuePage.js'))
const AdjusterDashboard = page(() => import('@/pages/adjuster/AdjusterDashboard.js'))
const ManagerDashboard = page(() => import('@/pages/manager/ManagerDashboard.js'))
const UnassignedClaimsPage = page(() => import('@/pages/manager/UnassignedClaimsPage.js'))
const ReserveApprovalsPage = page(() => import('@/pages/manager/ReserveApprovalsPage.js'))
const SettlementApprovalsPage = page(() => import('@/pages/manager/SettlementApprovalsPage.js'))
const DecisionHistoryPage = page(() => import('@/pages/manager/DecisionHistoryPage.js'))
const ComplianceQueuePage = page(() => import('@/pages/compliance/ComplianceQueuePage.js'))
const PaymentQueuePage = page(() => import('@/pages/payments/PaymentQueuePage.js'))
const PaymentDetailPage = page(() => import('@/pages/payments/PaymentDetailPage.js'))
const ReconciliationPage = page(() => import('@/pages/payments/ReconciliationPage.js'))
const ReportsPage = page(() => import('@/pages/reports/ReportsPage.js'))
const UsersPage = page(() => import('@/pages/admin/UsersPage.js'))
const AuditLogPage = page(() => import('@/pages/admin/AuditLogPage.js'))
const CustomerRecordsPage = page(() => import('@/pages/customer-records/CustomerRecordsPage.js'))
const CustomerRecordDetailPage = page(() => import('@/pages/customer-records/CustomerRecordDetailPage.js'))
const RemindersPage = page(() => import('@/pages/automation/RemindersPage.js'))
const ConfigurationPage = page(() => import('@/pages/config/ConfigurationPage.js'))
const IntegrationsPage = page(() => import('@/pages/integrations/IntegrationsPage.js'))
const NotificationsPage = page(() => import('@/pages/NotificationsPage.js'))
const ProfilePage = page(() => import('@/pages/ProfilePage.js'))
const UnauthorizedPage = page(() => import('@/pages/UnauthorizedPage.js'))
const NotFoundPage = page(() => import('@/pages/NotFoundPage.js'))

const guard = (roles, element) => <ProtectedRoute roles={roles}>{element}</ProtectedRoute>

export function AppRoutes() {
  return (
    <Suspense fallback={<FullPageLoader />}>
      <Routes>
        <Route element={<PublicOnlyRoute><AuthLayout /></PublicOnlyRoute>}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Route>
        <Route element={<AuthLayout />}>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Route>

        <Route element={<ProtectedRoute><AppShell /></ProtectedRoute>}>
          <Route index element={<RoleHomeRedirect />} />

          <Route path="customer" element={guard(RR.customer, <CustomerDashboard />)} />
          <Route path="customer/policies" element={guard(RR.customer, <MyPoliciesPage />)} />
          <Route path="customer/claims" element={guard(RR.customer, <MyClaimsPage />)} />
          <Route path="customer/claims/new" element={guard(RR.customer, <NewClaimPage />)} />
          <Route path="customer/claims/:id/edit" element={guard(RR.customer, <NewClaimPage />)} />
          <Route path="customer/claims/:id" element={guard(RR.customer, <CustomerClaimDetailPage />)} />
          <Route path="customer/requests" element={guard(RR.customer, <RequestsPage />)} />
          <Route path="customer/payments" element={guard(RR.customer, <CustomerPaymentsPage />)} />

          <Route path="operations" element={guard(RR.operations, <OperationsDashboard />)} />
          <Route path="policy-renewals" element={guard(RR.renewals, <PolicyRenewalsPage />)} />
          <Route path="claims" element={guard(RR.claims, <ClaimsQueuePage />)} />
          <Route path="claims/:id" element={guard(RR.claims, <ClaimDetailPage />)} />
          <Route path="tasks" element={guard(RR.tasks, <TasksPage />)} />
          <Route path="document-review" element={guard(RR.documentReview, <ReviewQueuePage />)} />
          <Route path="adjuster" element={guard(RR.adjuster, <AdjusterDashboard />)} />
          <Route path="manager" element={guard(RR.manager, <ManagerDashboard />)} />
          <Route path="manager/unassigned" element={guard(RR.unassigned, <UnassignedClaimsPage />)} />
          <Route path="manager/reserves" element={guard(RR.reserves, <ReserveApprovalsPage />)} />
          <Route path="settlements" element={guard(RR.settlements, <SettlementApprovalsPage />)} />
          <Route path="manager/decisions" element={guard(RR.decisions, <DecisionHistoryPage />)} />
          <Route path="compliance" element={guard(RR.compliance, <ComplianceQueuePage />)} />
          <Route path="payments" element={guard(RR.payments, <PaymentQueuePage key="queue" view="queue" />)} />
          <Route path="payments/history" element={guard(RR.payments, <PaymentQueuePage key="history" view="history" />)} />
          <Route path="payments/reconciliation" element={guard(RR.payments, <ReconciliationPage />)} />
          <Route path="payments/:id" element={guard(RR.payments, <PaymentDetailPage />)} />
          <Route path="reports" element={guard(RR.reports, <ReportsPage />)} />
          <Route path="audit" element={guard(RR.audit, <AuditLogPage />)} />
          <Route path="admin/users" element={guard(RR.admin, <UsersPage />)} />
          <Route path="customer-records" element={guard(RR.customerRecords, <CustomerRecordsPage />)} />
          <Route path="customer-records/:id" element={guard(RR.customerRecords, <CustomerRecordDetailPage />)} />
          <Route path="automation/reminders" element={guard(RR.automation, <RemindersPage />)} />
          <Route path="config" element={guard(RR.config, <ConfigurationPage />)} />
          <Route path="integrations" element={guard(RR.integrations, <IntegrationsPage />)} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="profile" element={<ProfilePage />} />
        </Route>

        <Route path="/unauthorized" element={<UnauthorizedPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Suspense>
  )
}
