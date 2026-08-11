import { componentStatuses, type Component } from './systemStatus.js';
import { notify } from './notify.js';
import { logSystem } from './systemLog.js';

/**
 * Turns the on-demand status snapshot into alerting: the scheduler calls this every
 * few minutes, and a component flipping up→down (or back) fires one notification and
 * one system-log entry — the edge, not the level, so a lasting outage alerts once.
 *
 * State is in-memory: after a restart the first pass only establishes a baseline and
 * never alerts, which is the right call — a fresh process has no outage to report.
 * ponytail: in-process only; a multi-instance deploy would double-alert — move the
 * last-state to a shared row then.
 */
const lastOk = new Map<string, boolean>();

export async function checkHealthAndAlert(): Promise<void> {
  await alertOnTransitions(await componentStatuses());
}

/** Alert on edges from an already-computed snapshot (the cron reuses one compute). */
export async function alertOnTransitions(components: Component[]): Promise<void> {
  for (const c of components) {
    const prev = lastOk.get(c.key);
    lastOk.set(c.key, c.ok);
    if (prev === undefined || prev === c.ok) continue; // baseline, or no change

    if (!c.ok) {
      logSystem('error', 'app', `${c.label} went down: ${c.detail}`, { component: c.key });
      await notify({ event: 'component_down', title: `${c.label} is down`, body: c.detail, severity: 'critical' });
    } else {
      logSystem('info', 'app', `${c.label} recovered`, { component: c.key });
      await notify({ event: 'component_recovered', title: `${c.label} recovered`, body: c.detail, severity: 'info' });
    }
  }
}
