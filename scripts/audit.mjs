// Fails on a high or critical advisory in the tree that ships. npm audit has no allowlist,
// and one advisory today sits in a package Zeus can never load — so the exceptions live
// here, each with its reason, and are removed when the upstream fix lands.
import { execFileSync } from 'node:child_process';

const IGNORED = {
  // Prisma's CLI pins it for MySQL databases. Zeus runs on Postgres and the CLI only
  // imports it lazily (cli.js: import("mysql2/promise")), so it never loads. Prisma 8
  // drops the dependency; delete this line when Zeus moves to it.
  mysql2: 'unreachable: Prisma CLI, MySQL only',
};

let out;
try {
  out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8' });
} catch (error) {
  out = error.stdout; // npm exits 1 whenever it found anything; the report is still on stdout
}
const found = Object.values(JSON.parse(out).vulnerabilities);
const ignored = (v) => IGNORED[v.name] || v.via.every((x) => IGNORED[typeof x === 'string' ? x : x.name]);
const blocking = found.filter((v) => ['high', 'critical'].includes(v.severity) && !ignored(v));

for (const v of found.filter(ignored)) console.log(`ignored  ${v.name} (${v.severity}) — ${IGNORED[v.name] ?? 'only via an ignored package'}`);
for (const v of blocking) console.log(`BLOCKING ${v.name} (${v.severity}) — ${v.via.map((x) => (typeof x === 'string' ? x : x.title)).join('; ')}`);
if (blocking.length) process.exit(1);
console.log(`audit clean: ${found.length - blocking.length} advisories, none blocking`);
