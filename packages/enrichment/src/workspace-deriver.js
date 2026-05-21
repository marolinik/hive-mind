/**
 * Derives a stable workspace id/name from the current working directory.
 */
import path from 'node:path';
import os from 'node:os';

const RESERVED = new Set(['personal', 'default']);

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isHomeOrRoot(cwd) {
  if (!cwd) return true;
  const norm = path.resolve(cwd);
  if (norm === path.resolve(os.homedir())) return true;
  // Windows drive root e.g. "C:\\"
  if (/^[A-Za-z]:[\\/]?$/.test(norm)) return true;
  if (norm === '/' || norm === '\\') return true;
  return false;
}

/**
 * @param {string} cwd
 * @returns {{id:string, name:string}}
 */
export function deriveWorkspace(cwd) {
  if (isHomeOrRoot(cwd)) return { id: 'personal', name: 'Personal' };
  const base = path.basename(path.resolve(cwd));
  const slug = slugify(base);
  if (!slug) return { id: 'personal', name: 'Personal' };
  if (RESERVED.has(slug)) return { id: `proj-${slug}`, name: base };
  return { id: `proj-${slug}`, name: base };
}
