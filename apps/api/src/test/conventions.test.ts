import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rules that hold everywhere, checked by reading the source rather than by exercising it.
 *
 * Zeus's most expensive defects have all had the same shape: a rule that must hold on
 * every route, implemented on most of them. `.partial()` keeping Zod 4 defaults corrupted
 * data through every PATCH; a report handed reps the buy prices the screen refused. A
 * hand-written test per route cannot catch the route nobody thought about — but where the
 * rule is *syntactic*, a scan of the tree catches all of them, including the ones written
 * next year, in milliseconds and without a database.
 *
 * Exemptions are listed explicitly on purpose: a new file that breaks a rule fails here
 * until somebody either fixes it or writes down why it is allowed.
 */
const SRC = new URL('../', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sourceFiles(join(dir, entry.name)));
    else if (entry.name.endsWith('.ts')) out.push(join(dir, entry.name));
  }
  return out;
}
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

describe('conventions the whole codebase keeps', () => {
  /**
   * The Zod 4 upgrade made `.partial()` keep every `.default()`, so a PATCH body of
   * `{ name }` silently arrived as `{ name, type: 'PROSPECT', cost: 0, … }` and the update
   * overwrote fields nobody sent. `patchOf()` is the fix; this makes the mistake unwritable.
   */
  it('no route builds a patch body with .partial() — patchOf() exists for that', () => {
    const offenders = [...sourceFiles('routes'), ...sourceFiles('portal')]
      .filter((f) => /\.partial\(\)/.test(read(f)));
    assert.deepEqual(offenders, [], 'use patchOf(schema); .partial() keeps Zod defaults and overwrites unsent fields');
  });

  /**
   * A route file with no permission check is a route file that anybody signed in can use.
   * The exempt ones are exempt for a stated reason, not by omission.
   */
  it('every route file gates on a permission, or says why it does not', () => {
    const EXEMPT: Record<string, string> = {
      'routes/auth.ts': 'sign-in itself — there is no session yet to check a permission against',
      'routes/accessRequests.ts': 'the portal request form is deliberately unauthenticated',
      'routes/portal.ts': 'guarded by the portal gate and its own cookie, not by staff RBAC',
      'routes/undo.ts': 'authorises in services/undo.ts::refuseReason — can() on the module being undone',
    };
    // can() on the parent record's module counts: attachments and undo authorise
    // against the thing being touched, which is stricter than a flat route check.
    const ungated = sourceFiles('routes')
      .filter((f) => !/requirePermission|requireElevated|\bcan\(/.test(read(f)))
      .filter((f) => !(f in EXEMPT));
    assert.deepEqual(ungated, [], 'add requirePermission, or list the file in EXEMPT with a reason');

    // An exemption for a file that no longer exists is a comment pretending to be a rule.
    const present = new Set(sourceFiles('routes'));
    assert.deepEqual(Object.keys(EXEMPT).filter((f) => !present.has(f)), [], 'stale exemption — the file is gone');
  });

  /**
   * Money that a role may not see must not reach it through *any* route. The screen
   * refusing to draw it is not the control; masking on the way out is.
   */
  it('every route that returns a cost goes through the masking helpers', () => {
    const EXEMPT = new Set([
      'routes/imports.ts', // writes cost, never returns a record
      // Margin reaches only roles with deals:approve — everyone else gets an empty
      // list rather than a masked one, which is the stricter answer.
      'routes/approvals.ts',
    ]);
    const leaky = sourceFiles('routes')
      .filter((f) => !EXEMPT.has(f))
      .filter((f) => /\bcost\b/.test(read(f)))
      .filter((f) => !/maskFields|stripUnwritableFields|maskRecord|permissionFor/.test(read(f)));
    assert.deepEqual(leaky, [], 'a route touching cost must mask it for roles that may not see it');
  });
});
