import os from 'node:os';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../lib/http.js';
import { recentLogs, exportLogs } from '../services/systemLog.js';
import { componentStatuses, uptimeSummary } from '../services/systemStatus.js';
import { sampleResources, resourceHistory } from '../services/resources.js';
import { tableXlsx } from '../services/xlsx.js';
import { audit } from '../lib/audit.js';
import { clientIp } from '../lib/http.js';

/**
 * Status page + system log for the internal team. Both are read-only and gated by
 * the same permission as the audit trail — whoever may see who did what may also see
 * how the machine is doing.
 */

export default async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/system/status', { preHandler: requirePermission('audit', 'read') }, async () => {
    const [components, uptime, resourcesNow, history] = await Promise.all([
      componentStatuses(), uptimeSummary(), sampleResources(), resourceHistory(24),
    ]);
    const mem = process.memoryUsage();

    return {
      service: 'zeus-api',
      time: new Date().toISOString(),
      ok: components.every((c) => c.ok),
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        node: process.version,
        pid: process.pid,
        rssMb: Math.round(mem.rss / 1_048_576),
        heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
      },
      components: components.map((c) => ({ ...c, uptime: uptime[c.key] ?? null })),
      resources: {
        current: { ...resourcesNow, totalMemMb: Math.round(os.totalmem() / 1_048_576) },
        history,
      },
    };
  });

  app.get('/api/system/logs', { preHandler: requirePermission('audit', 'read') }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    return recentLogs({
      level: q.level || undefined,
      source: q.source || undefined,
      search: q.search || undefined,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 50,
    });
  });

  app.get('/api/system/logs/export', { preHandler: requirePermission('audit', 'read') }, async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const rows = await exportLogs({ level: q.level || undefined, source: q.source || undefined, search: q.search || undefined });
    const buffer = await tableXlsx({
      title: 'System log',
      columns: [
        { key: 'at', label: 'Time', format: 'date' },
        { key: 'level', label: 'Level' },
        { key: 'source', label: 'Source' },
        { key: 'message', label: 'Message', width: 80 },
      ],
      rows: rows.map((r) => ({ at: r.at, level: r.level, source: r.source, message: r.message })),
    });
    await audit({ user: request.user, action: 'export', entity: 'SystemLog', summary: `System log (${rows.length} rows)`, ip: clientIp(request) });
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="zeus-system-log-${new Date().toISOString().slice(0, 10)}.xlsx"`)
      .send(buffer);
  });
}
