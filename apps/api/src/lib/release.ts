import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../env.js';

/** The release this process is running: the image tag on the box, "dev" anywhere else. */
export const version = env.ZEUS_VERSION;

/**
 * The CHANGELOG section for one release — the heading line included — or nothing when
 * the changelog does not know that version. "dev" reads the Unreleased section.
 */
export function changesFor(release: string, changelog: string): string {
  const heading = release === 'dev' ? '\n## Unreleased' : `\n## ${release} `;
  const start = changelog.indexOf(heading);
  if (start < 0) return '';
  const body = changelog.slice(start + 1);
  const end = body.indexOf('\n## ');
  return (end < 0 ? body : body.slice(0, end)).trim();
}

// The image carries CHANGELOG.md beside the API; in development it is two directories up.
const file = ['CHANGELOG.md', '../../CHANGELOG.md'].map((f) => resolve(f)).find(existsSync);
export const changes = file ? changesFor(version, readFileSync(file, 'utf8')) : '';
