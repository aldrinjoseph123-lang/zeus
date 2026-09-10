import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Rules the whole front end keeps, checked by reading the tree.
 *
 * Five of the twenty-three defects this project has fixed were UI — a switch drawn
 * twice, a label that wrapped and pushed its field out of line, a lookup menu that
 * would not close, and the same menu bug again in the portal. Nothing tests the UI, so
 * every one of them was found by a person looking at the screen.
 *
 * These are the ones a scan can catch outright. They cost nothing to run and they
 * cover every file, including the ones written after this comment.
 */
const SRC = new URL('../', import.meta.url).pathname;

function files(dir: string, ext = '.tsx'): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(SRC, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...files(join(dir, entry.name), ext));
    else if (entry.name.endsWith(ext)) out.push(join(dir, entry.name));
  }
  return out;
}
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

/**
 * `<Link><Button>…</Button></Link>` renders a <button> inside an <a>. Browsers navigate
 * anyway, so it looks fine and is invalid HTML: two tab stops for one control, and a
 * screen reader announcing a button inside a link. Button takes the navigation itself.
 */
function noButtonInsideLink() {
  const offenders: string[] = [];
  for (const f of files('')) {
    const src = read(f);
    // Same line or the next two — the shapes this pattern is actually written in.
    const re = /<Link\b[^>]*>\s*(?:\{[^}]*\}\s*)?<Button\b/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) offenders.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
  }
  assert.deepEqual(offenders, [], 'a <button> inside an <a> is invalid HTML — give Button the navigation instead');
}

/**
 * `var(--token, #literal)` silently falls back when --token does not exist, so the
 * literal becomes the real value — in every theme at once. That is how the dashboard's
 * server-error banner came to flash light pink on hover in dark mode: --red-100 was
 * never defined, and #fee2e2 is a light-mode colour. The fallback is what makes it
 * invisible; nothing errors, nothing logs, it just quietly renders the wrong theme.
 *
 * A colour is only theme-aware if theme.css actually defines it, so that is the check.
 */
function noFallbackToUndefinedToken() {
  const theme = read('theme.css');
  const defined = new Set([...theme.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  const offenders: string[] = [];
  for (const f of [...files(''), ...files('', '.ts'), ...files('', '.css')]) {
    // theme.css declares the tokens; this file names one in its own comment.
    if (f.endsWith('theme.css') || f.endsWith('conventions.check.ts')) continue;
    const src = read(f);
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)\s*,/g)) {
      if (!defined.has(m[1])) {
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length} ${m[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'these fall back to a hard-coded colour because theme.css never defines the token');
}

/**
 * Deliberately not here: "every settings key is rendered exactly once", the rule the
 * duplicated bot-check switch broke. It cannot be decided by reading the source — a
 * SettingsGroup renders a whole prefix, and the keys it is told to skip arrive as a
 * computed constant. Counting the controls on the rendered page answers it exactly,
 * so it belongs in the browser sweep, not here.
 */

noButtonInsideLink();
noFallbackToUndefinedToken();
console.log('✔ front-end conventions');
