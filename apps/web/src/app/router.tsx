import { Loading } from "@/shared/ui";
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ConsoleLayout } from "./layouts/ConsoleLayout";
const AccountsPage = lazy(
  () => import("@/features/accounts/pages/AccountsPage"),
);
const GroupsPage = lazy(() => import("@/features/groups/pages/GroupsPage"));
const GroupDetailPage = lazy(
  () => import("@/features/groups/pages/GroupDetailPage"),
);
const AgentRunPage = lazy(() => import("@/features/agent/pages/AgentRunPage"));
const SequencesPage = lazy(
  () => import("@/features/sequences/pages/SequencesPage"),
);
export function AppRoutes() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<ConsoleLayout />}>
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/groups/:id" element={<GroupDetailPage />} />
          <Route path="/agent-runs/:id" element={<AgentRunPage />} />
          <Route path="/sequences" element={<SequencesPage />} />
          <Route path="*" element={<Navigate to="/accounts" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
