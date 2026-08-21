import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout, { AccessDenied } from './components/Layout';
import { useAuth } from './lib/auth';
import { Loading } from './components/ui';

// Loaded up front: the screens someone lands on, and the ones they move between all day.
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

/**
 * Fetched when first opened.
 *
 * These are the heavy screens — the three document editors carry the line grid and its
 * pricing lookups, Reports pulls in the chart library, Settings is nine panels of admin
 * — and none of them is where a working day starts. Splitting them out means the first
 * paint no longer waits for code most sessions never touch.
 */
const Quotes = lazy(() => import('./pages/Quotes'));
const QuoteEditor = lazy(() => import('./pages/QuoteEditor'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceEditor = lazy(() => import('./pages/InvoiceEditor'));
const PurchaseOrders = lazy(() => import('./pages/PurchaseOrders'));
const PurchaseOrderEditor = lazy(() => import('./pages/PurchaseOrderEditor'));
const Products = lazy(() => import('./pages/Products'));
const PriceBook = lazy(() => import('./pages/PriceBook'));
const Renewals = lazy(() => import('./pages/Renewals'));
const Reports = lazy(() => import('./pages/Reports'));
const Coaching = lazy(() => import('./pages/Coaching'));
const Imports = lazy(() => import('./pages/Imports'));
const Settings = lazy(() => import('./pages/Settings'));

/** Gate a route on a module permission rather than hiding it silently. */
// React 19's types dropped the global JSX namespace in favour of React.JSX.
function Guard({ module, children }: { module: string; children: React.JSX.Element }) {
  const { can, loading } = useAuth();
  if (loading) return <Loading />;
  return can(module, 'read') ? children : <AccessDenied module={module} />;
}

export default function App() {
  return (
    // One boundary around the lot: a route swap is fast enough that per-route spinners
    // would only flicker.
    <Suspense fallback={<Loading />}>
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

        <Route path="renewals" element={<Guard module="deals"><Renewals /></Guard>} />
        <Route path="price-book" element={<Guard module="products"><PriceBook /></Guard>} />
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
        <Route path="coaching" element={<Guard module="deals"><Coaching /></Guard>} />
        <Route path="imports" element={<Guard module="imports"><Imports /></Guard>} />
        <Route path="settings/*" element={<Settings />} />

        <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
