import { Navigate, Route, Routes } from 'react-router-dom';
import Layout, { AccessDenied } from './components/Layout';
import { useAuth } from './lib/auth';
import { Loading } from './components/ui';

import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Deals from './pages/Deals';
import DealDetail from './pages/DealDetail';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import Accounts from './pages/Accounts';
import AccountDetail from './pages/AccountDetail';
import Contacts from './pages/Contacts';
import Activities from './pages/Activities';
import Quotes from './pages/Quotes';
import QuoteEditor from './pages/QuoteEditor';
import Invoices from './pages/Invoices';
import InvoiceEditor from './pages/InvoiceEditor';
import PurchaseOrders from './pages/PurchaseOrders';
import PurchaseOrderEditor from './pages/PurchaseOrderEditor';
import Products from './pages/Products';
import Reports from './pages/Reports';
import Imports from './pages/Imports';
import Settings from './pages/Settings';

/** Gate a route on a module permission rather than hiding it silently. */
function Guard({ module, children }: { module: string; children: JSX.Element }) {
  const { can, loading } = useAuth();
  if (loading) return <Loading />;
  return can(module, 'read') ? children : <AccessDenied module={module} />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route element={<Layout />}>
        <Route index element={<Guard module="dashboard"><Dashboard /></Guard>} />

        <Route path="deals" element={<Guard module="deals"><Deals /></Guard>} />
        <Route path="deals/:id" element={<Guard module="deals"><DealDetail /></Guard>} />

        <Route path="leads" element={<Guard module="leads"><Leads /></Guard>} />
        <Route path="leads/:id" element={<Guard module="leads"><LeadDetail /></Guard>} />

        <Route path="accounts" element={<Guard module="accounts"><Accounts /></Guard>} />
        <Route path="accounts/:id" element={<Guard module="accounts"><AccountDetail /></Guard>} />

        <Route path="contacts" element={<Guard module="contacts"><Contacts /></Guard>} />
        <Route path="activities" element={<Guard module="activities"><Activities /></Guard>} />

        <Route path="quotes" element={<Guard module="quotes"><Quotes /></Guard>} />
        <Route path="quotes/new" element={<Guard module="quotes"><QuoteEditor /></Guard>} />
        <Route path="quotes/:id" element={<Guard module="quotes"><QuoteEditor /></Guard>} />
        <Route path="invoices" element={<Guard module="invoices"><Invoices /></Guard>} />
        <Route path="invoices/new" element={<Guard module="invoices"><InvoiceEditor /></Guard>} />
        <Route path="invoices/:id" element={<Guard module="invoices"><InvoiceEditor /></Guard>} />
        <Route path="purchase-orders" element={<Guard module="invoices"><PurchaseOrders /></Guard>} />
        <Route path="purchase-orders/new" element={<Guard module="invoices"><PurchaseOrderEditor /></Guard>} />
        <Route path="purchase-orders/:id" element={<Guard module="invoices"><PurchaseOrderEditor /></Guard>} />
        <Route path="products" element={<Guard module="products"><Products /></Guard>} />

        <Route path="reports" element={<Guard module="reports"><Reports /></Guard>} />
        <Route path="imports" element={<Guard module="imports"><Imports /></Guard>} />
        <Route path="settings/*" element={<Settings />} />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
