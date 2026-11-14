import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { AppLayout } from '@/layouts/AppLayout';
import { Dashboard } from '@/pages/dashboard/Dashboard';
import { NetworkBasics } from '@/pages/network/NetworkBasics';
import { DockerBuild } from '@/pages/docker/DockerBuild';
import { DockerCompose } from '@/pages/docker/DockerCompose';
import { KubernetesDeploy } from '@/pages/k8s/KubernetesDeploy';
import { CICDPipeline } from '@/pages/cicd/CICDPipeline';
import { LearningPath } from '@/pages/learn/LearningPath';
import { Login } from '@/pages/login/Login';
import { UnitPage } from '@/pages/units/UnitPage';
import { IS_PILOT, ROUTES } from '@/config/constants';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading } = useAuth();

  // パイロットはログインをしない設計（認証 API も無い）ので素通しする。通常モードは従来どおり
  if (IS_PILOT) return <>{children}</>;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />;
}

function AppRoutes() {
  return (
    <Routes>
      {/* パイロットはログインが無い設計。Dashboard・Learning Path は DB 前提で開けないため N5 単元へ送る */}
      <Route path="/login" element={IS_PILOT ? <Navigate to={ROUTES.UNIT_N5} replace /> : <Login />} />
      {/* 学習エンジン新経路（N5 パイロット）。単一利用者構成のため認証を要求しない */}
      <Route
        path="/units/:unitId"
        element={
          <AppLayout>
            <UnitPage />
          </AppLayout>
        }
      />
      <Route
        path="/"
        element={
          IS_PILOT ? (
            <Navigate to={ROUTES.UNIT_N5} replace />
          ) : (
            <ProtectedRoute>
              <AppLayout>
                <Dashboard />
              </AppLayout>
            </ProtectedRoute>
          )
        }
      />
      <Route
        path="/network"
        element={
          <ProtectedRoute>
            <AppLayout>
              <NetworkBasics />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/docker"
        element={
          <ProtectedRoute>
            <AppLayout>
              <DockerBuild />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/compose"
        element={
          <ProtectedRoute>
            <AppLayout>
              <DockerCompose />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/kubernetes"
        element={
          <ProtectedRoute>
            <AppLayout>
              <KubernetesDeploy />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/cicd"
        element={
          <ProtectedRoute>
            <AppLayout>
              <CICDPipeline />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/learning"
        element={
          IS_PILOT ? (
            <Navigate to={ROUTES.UNIT_N5} replace />
          ) : (
            <ProtectedRoute>
              <AppLayout>
                <LearningPath />
              </AppLayout>
            </ProtectedRoute>
          )
        }
      />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}

export default App;
