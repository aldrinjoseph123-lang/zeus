import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Mail, NotebookPen, PhoneCall } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { LogActivityModal, type TimelineLinks } from './timeline';

const ICON = 'inline-flex h-7 w-7 items-center justify-center rounded-sharp text-muted transition-colors hover:bg-card hover:text-ink focus-visible:outline-2 focus-visible:outline-accent';

/**
 * The buttons at the end of a list row: call, email, log what happened, open. What a person
 * does with a record most often, without opening it first. Each shows only when there is
 * something to do it with: no Call without a number.
 */
export function QuickActions({ phone, email, log, open }: {
  phone?: string | null;
  email?: string | null;
  log?: { title: string; links: TimelineLinks };
  open?: string | null;
}) {
  const { can } = useAuth();
  const [logging, setLogging] = useState(false);
  return (
    <>
      {phone ? <a href={`tel:${phone.replace(/[^\d+]/g, '')}`} title={`Call ${phone}`} className={ICON}><PhoneCall size={14} /></a> : null}
      {email ? <a href={`mailto:${email}`} title={`Email ${email}`} className={ICON}><Mail size={14} /></a> : null}
      {log && can('activities', 'create') ? (
        <button type="button" title="Log a call, note or meeting" onClick={() => setLogging(true)} className={ICON}><NotebookPen size={14} /></button>
      ) : null}
      {/* data-no-preview: the row's name already previews the record; the Open button just opens it. */}
      {open ? <Link to={open} title="Open" data-no-preview className={ICON}><ArrowUpRight size={14} /></Link> : null}
      {/* Out of the row: the row's buttons fade with hover, and a dialog must not fade with them. */}
      {logging && log ? createPortal(<LogActivityModal title={log.title} links={log.links} onClose={() => setLogging(false)} />, document.body) : null}
    </>
  );
}
