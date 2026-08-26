import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
];

function normalizedRecord(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  ));
}

export function collectWorkspaceLockErrors(workspaces, lockPackages) {
  const errors = [];

  for (const { path, manifest } of workspaces) {
    const workspacePath = path.replaceAll('\\', '/');
    const lockEntry = lockPackages[workspacePath];
    if (!lockEntry) {
      errors.push(`${workspacePath} is missing from package-lock.json`);
      continue;
    }

    for (const field of ['name', 'version']) {
      if (manifest[field] !== lockEntry[field]) {
        errors.push(
          `${workspacePath} ${field} expected ${JSON.stringify(manifest[field])} but lock has ${JSON.stringify(lockEntry[field])}`,
        );
      }
    }

    for (const field of dependencyFields) {
      const expected = normalizedRecord(manifest[field]);
      const actual = normalizedRecord(lockEntry[field]);
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        errors.push(
          `${workspacePath} ${field} expected ${JSON.stringify(expected)} but lock has ${JSON.stringify(actual)}`,
        );
      }
    }
  }

  return errors;
}

async function loadWorkspaces(rootDir, patterns) {
  const paths = [];

  for (const pattern of patterns) {
    if (!pattern.includes('*')) {
      paths.push(pattern);
      continue;
    }

    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }

    const parent = pattern.slice(0, -2);
    const entries = await readdir(join(rootDir, parent), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        paths.push(`${parent}/${entry.name}`);
      }
    }
  }

  const workspaces = [];
  for (const path of [...new Set(paths)].sort()) {
    try {
      const manifest = JSON.parse(await readFile(join(rootDir, path, 'package.json'), 'utf8'));
      workspaces.push({ path, manifest });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  return workspaces;
}

function matchesWorkspacePattern(path, pattern) {
  if (!pattern.includes('*')) return path === pattern;
  const parent = pattern.slice(0, -2);
  return path.startsWith(`${parent}/`) && !path.slice(parent.length + 1).includes('/');
}

export async function verifyWorkspaceLock(rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const rootPackage = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(rootDir, 'package-lock.json'), 'utf8'));
  const patterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : rootPackage.workspaces?.packages;

  if (!Array.isArray(patterns) || patterns.length === 0) {
    throw new Error('package.json must declare at least one workspace pattern');
  }
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error('package-lock.json must contain a packages map');
  }

  const workspaces = await loadWorkspaces(rootDir, patterns);
  if (workspaces.length === 0) {
    throw new Error('No workspace manifests were discovered from package.json patterns');
  }

  const workspacePaths = new Set(
    workspaces.map((workspace) => workspace.path.replaceAll('\\', '/')),
  );
  const orphanedLockPaths = Object.keys(lock.packages).filter(
    (path) => patterns.some((pattern) => matchesWorkspacePattern(path, pattern))
      && !workspacePaths.has(path),
  );
  if (orphanedLockPaths.length > 0) {
    throw new Error(`Orphaned workspace lock entries: ${orphanedLockPaths.sort().join(', ')}`);
  }

  const errors = collectWorkspaceLockErrors(workspaces, lock.packages);
  if (errors.length > 0) {
    throw new Error(`Workspace lock verification failed:\n- ${errors.join('\n- ')}`);
  }

  return workspaces.length;
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (entryPoint === import.meta.url) {
  try {
    const count = await verifyWorkspaceLock();
    console.log(`Verified package-lock.json metadata for ${count} workspaces.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
