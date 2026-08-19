import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AuthProvider } from './auth/AuthContext'
import { RequireAuth } from './auth/RequireAuth'
import { AppShell } from './components/AppShell'
import { ClientsPage } from './pages/ClientsPage'
import { LoginPage } from './pages/LoginPage'
import { NodesPage } from './pages/NodesPage'
import { AuditPage, CcdPage, TrafficPage } from './pages/PlaceholderPage'
import { PkiPage } from './pages/PkiPage'
import { ThemeProvider } from './theme/ThemeContext'

export default function App() {
  return (
    <ThemeProvider>
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
              <Route path="/nodes" element={<NodesPage />} />
              <Route path="/clients" element={<ClientsPage />} />
              <Route path="/pki" element={<PkiPage />} />
              <Route path="/ccd" element={<CcdPage />} />
              <Route path="/traffic" element={<TrafficPage />} />
              <Route path="/audit" element={<AuditPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/nodes" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  )
}
