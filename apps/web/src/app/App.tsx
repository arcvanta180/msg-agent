import { useAuth } from "@/features/auth/AuthProvider";
import LoginPage from "@/features/auth/pages/LoginPage";
import { StreamProvider } from "@/features/realtime/StreamProvider";
import { Loading } from "@/shared/ui";
import { AppRoutes } from "./router";
export function App() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  return user ? (
    <StreamProvider>
      <AppRoutes />
    </StreamProvider>
  ) : (
    <LoginPage />
  );
}
