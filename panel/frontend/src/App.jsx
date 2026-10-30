import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AuthProvider } from './auth/AuthContext'
import { RequireAuth } from './auth/RequireAuth'
import { AppShell } from './components/AppShell'
import { ToastProvider } from './components/Toast'
import { AuditPage } from './pages/AuditPage'
import { CcdPage } from './pages/CcdPage'
import { ClientsPage } from './pages/ClientsPage'
import { LoginPage } from './pages/LoginPage'
import { MapPage } from './pages/MapPage'
import { NodePage } from './pages/NodePage'
import { NodesPage } from './pages/NodesPage'
import { PkiPage } from './pages/PkiPage'
import { TrafficPage } from './pages/TrafficPage'
import { ThemeProvider } from './theme/ThemeContext'

export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                element={
                  <RequireAuth>
                    <AppShell />
                  </RequireAuth>
                }
              >
                <Route path="/map" element={<MapPage />} />
                <Route path="/clients" element={<ClientsPage />} />
                <Route path="/nodes" element={<NodesPage />} />
                <Route path="/nodes/:nodeId" element={<NodePage />} />
                <Route path="/ccd" element={<CcdPage />} />
                <Route path="/pki" element={<PkiPage />} />
                <Route path="/traffic" element={<TrafficPage />} />
                <Route path="/audit" element={<AuditPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/map" replace />} />
            </Routes>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </ThemeProvider>
  )
}
