import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTestDatabase, prisma, resetDatabase } from './harness.js';
import { sampleResources, recordResourceSample, resourceHistory, pruneResourceSamples } from '../services/resources.js';

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); });

describe('compute resource sampling', () => {
  it('samples CPU, RAM and disk as sane percentages', async () => {
    const s = await sampleResources();
    for (const [k, v] of Object.entries(s)) {
      assert.ok(v >= 0 && v <= 100, `${k}=${v} should be a 0-100 percentage`);
    }
    assert.ok(s.memPct > 0, 'memory is always partly used');
  });

  it('records a sample and reads it back in history', async () => {
    await recordResourceSample();
    const hist = await resourceHistory(24);
    assert.equal(hist.length, 1);
    assert.ok('cpuPct' in hist[0] && 'memPct' in hist[0] && 'diskPct' in hist[0]);
  });

  it('prunes samples older than the window', async () => {
    await prisma.resourceSample.create({ data: { cpuPct: 1, memPct: 1, diskPct: 1, at: new Date(Date.now() - 10 * 86_400_000) } });
    await recordResourceSample();
    assert.equal(await pruneResourceSamples(7), 1, 'only the 10-day-old row is pruned');
    assert.equal((await resourceHistory(24)).length, 1);
  });
});
