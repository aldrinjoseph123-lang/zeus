import { prisma } from '../db.js';
import { forwardToSyslog } from './syslog.js';

/**
 * Application event log behind the status page. Distinct from AuditLog (what users
 * did): this records what the *system* did — unhandled errors, failed jobs, backup
 * and integration trouble. Writing is fire-and-forget: a logging failure must never
 * take down the request that was being logged.
 */

export type LogLevel = 'info' | 'warn' | 'error';
export type LogSource = 'http' | 'backup' | 'cron' | 'integration' | 'auth' | 'app';

export function logSystem(level: LogLevel, source: LogSource, message: string, context?: unknown): void {
  const text = String(message).slice(0, 2000);
  void prisma.systemLog.create({ data: { level, source, message: text, context: (context ?? undefined) as never } }).catch(() => undefined);
  // Fan out to the SIEM if one is configured — best-effort, never blocks the caller.
  void forwardToSyslog(level, source, text).catch(() => undefined);
}

export interface LogQuery {
  level?: string;
  source?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function recentLogs(q: LogQuery) {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
  const where = {
    ...(q.level ? { level: q.level } : {}),
    ...(q.source ? { source: q.source } : {}),
    ...(q.search ? { message: { contains: q.search, mode: 'insensitive' as const } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.systemLog.findMany({ where, orderBy: { at: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.systemLog.count({ where }),
  ]);
  return { data: rows, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Rows for a download — same filters as the viewer, capped so an export cannot OOM. */
export async function exportLogs(q: Pick<LogQuery, 'level' | 'source' | 'search'>) {
  return prisma.systemLog.findMany({
    where: {
      ...(q.level ? { level: q.level } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...(q.search ? { message: { contains: q.search, mode: 'insensitive' as const } } : {}),
    },
    orderBy: { at: 'desc' },
    take: 5000,
  });
}

/** Nightly retention. ponytail: time-based prune only; add a row cap if volume spikes. */
export async function pruneSystemLogs(keepDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000);
  const { count } = await prisma.systemLog.deleteMany({ where: { at: { lt: cutoff } } });
  return count;
}
