import { Download } from 'lucide-react';
import { ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, useToast } from './ui';

/** The list exports as an Excel file, filtered and sorted exactly as it is on screen. */
const MODULE: Record<string, string> = { 'purchase-orders': 'invoices' };

export function ExportButton({ list, query }: { list: string; query: Record<string, unknown> }) {
  const { can } = useAuth();
  const toast = useToast();
  if (!can(MODULE[list] ?? list, 'export')) return null;
  const run = () =>
    download(`/export/${list}${qs(query)}`, `zeus-${list}.xlsx`)
      .then(() => toast.push('Excel downloaded.'))
      .catch((err) => toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error'));
  return <Button size="sm" icon={<Download size={13} />} onClick={run}>Excel</Button>;
}
