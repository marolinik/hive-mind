import fs from 'node:fs';
import path from 'node:path';

/**
 * Per-workspace configuration persisted to disk as workspace.json.
 *
 * Intentionally minimal — a workspace is the unit that owns one
 * `workspace.mind` file and a sessions/ directory. Callers that need
 * richer per-workspace settings (personas, tool allowlists, external
 * integrations) should compose on top of this rather than extending
 * the core shape.
 */
export interface WorkspaceConfig {
  id: string;
  name: string;
  /** Free-form grouping label; used by listByGroup/listGroups. */
  group: string;
  icon?: string;
  /** Default model id for this workspace. Consumer-defined semantics. */
  model?: string;
  /** ISO 8601 creation timestamp. */
  created: string;
}

export interface CreateWorkspaceOptions {
  name: string;
  group: string;
  icon?: string;
  model?: string;
}

interface WorkspacesMeta {
  defaultWorkspace?: string | null;
}

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !path.isAbsolute(relative)
    && !relative.startsWith(`..${path.sep}`);
}

/**
 * WorkspaceManager owns the on-disk layout:
 *
 *     {baseDir}/workspaces/{id}/workspace.json    # this config
 *     {baseDir}/workspaces/{id}/workspace.mind    # per-workspace MindDB file
 *     {baseDir}/workspaces/{id}/sessions/         # optional sessions dir
 *     {baseDir}/workspaces-meta.json              # default workspace pointer
 */
export class WorkspaceManager {
  private readonly workspacesDir: string;
  private readonly canonicalWorkspacesDir: string;
  private readonly metaPath: string;

  constructor(baseDir: string) {
    this.workspacesDir = path.join(baseDir, 'workspaces');
    this.metaPath = path.join(baseDir, 'workspaces-meta.json');

    if (!fs.existsSync(this.workspacesDir)) {
      fs.mkdirSync(this.workspacesDir, { recursive: true });
    }
    const rootStat = fs.lstatSync(this.workspacesDir);
    const canonicalBase = fs.realpathSync.native(baseDir);
    const canonicalRoot = fs.realpathSync.native(this.workspacesDir);
    if (
      rootStat.isSymbolicLink()
      || !rootStat.isDirectory()
      || !isContained(canonicalBase, canonicalRoot)
    ) {
      throw new Error('Workspace root must be a regular directory inside the data directory');
    }
    this.canonicalWorkspacesDir = canonicalRoot;
  }

  /** Create a new workspace directory, empty .mind file, and workspace.json. */
  create(options: CreateWorkspaceOptions): WorkspaceConfig {
    const id = this.generateId(options.name);
    this.assertWorkspaceId(id);
    const wsDir = path.join(this.resolveWorkspaceRoot(), id);

    fs.mkdirSync(wsDir);
    fs.mkdirSync(path.join(wsDir, 'sessions'), { recursive: true });
    // Touch workspace.mind — MindDB initialises the schema on first open.
    fs.writeFileSync(path.join(wsDir, 'workspace.mind'), '');

    const config: WorkspaceConfig = {
      id,
      name: options.name,
      group: options.group,
      ...(options.icon !== undefined && { icon: options.icon }),
      ...(options.model !== undefined && { model: options.model }),
      created: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(wsDir, 'workspace.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );

    return config;
  }

  /**
   * Ensure a workspace with the given id exists. Idempotent — returns the
   * existing config unchanged if the workspace already exists; otherwise
   * creates it with the supplied id (bypassing slug-collision handling in
   * generateId, since callers construct ids from trusted internal state
   * like CWD-derived prefixes — e.g. SessionStart hooks).
   *
   * Use this from auto-attach paths (e.g. save_memory with a workspace arg
   * that names a workspace not yet created on disk). Direct-create flows
   * with user-supplied names should still go through `create()` so the
   * generateId collision logic runs.
   */
  ensure(
    id: string,
    options: { name?: string; group?: string; icon?: string; model?: string } = {},
  ): WorkspaceConfig {
    this.assertWorkspaceId(id);
    const existing = this.get(id);
    if (existing) return existing;

    const wsDir = path.join(this.resolveWorkspaceRoot(), id);
    fs.mkdirSync(wsDir);
    fs.mkdirSync(path.join(wsDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'workspace.mind'), '');

    const config: WorkspaceConfig = {
      id,
      name: options.name ?? id,
      group: options.group ?? 'auto',
      ...(options.icon !== undefined && { icon: options.icon }),
      ...(options.model !== undefined && { model: options.model }),
      created: new Date().toISOString(),
    };

    fs.writeFileSync(
      path.join(wsDir, 'workspace.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );

    return config;
  }

  /** List every workspace by reading workspace.json from each subdirectory. */
  list(): WorkspaceConfig[] {
    const entries = fs.readdirSync(this.resolveWorkspaceRoot(), { withFileTypes: true });
    const configs: WorkspaceConfig[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || !WORKSPACE_ID.test(entry.name)) continue;
      const config = this.get(entry.name);
      if (config) configs.push(config);
    }

    return configs;
  }

  listByGroup(group: string): WorkspaceConfig[] {
    return this.list().filter((ws) => ws.group === group);
  }

  listGroups(): string[] {
    const groups = new Set(this.list().map((ws) => ws.group));
    return [...groups];
  }

  get(id: string): WorkspaceConfig | null {
    if (!WORKSPACE_ID.test(id)) return null;
    try {
      const configPath = this.resolveConfigPath(id);
      if (!configPath) return null;
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
      return config.id === id ? config : null;
    } catch {
      return null;
    }
  }

  update(id: string, updates: Partial<Omit<WorkspaceConfig, 'id' | 'created'>>): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`Workspace not found: ${id}`);

    const updated = { ...existing, ...updates };
    const configPath = this.resolveConfigPath(id);
    if (!configPath) throw new Error(`Workspace not found: ${id}`);
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf-8');
  }

  delete(id: string): void {
    this.assertWorkspaceId(id);
    if (!this.get(id)) return;
    const workspaceDir = this.resolveWorkspaceDir(id);
    if (workspaceDir) fs.rmSync(workspaceDir, { recursive: true, force: true });
  }

  /** Absolute path to a workspace's .mind file. */
  getMindPath(id: string): string {
    this.assertWorkspaceId(id);
    const lexicalMindPath = path.join(this.workspacesDir, id, 'workspace.mind');
    if (!this.resolveConfigPath(id)) throw new Error(`Workspace not found: ${id}`);
    const workspaceDir = this.resolveWorkspaceDir(id);
    if (!workspaceDir) throw new Error(`Workspace not found: ${id}`);
    const mindPath = path.join(workspaceDir, 'workspace.mind');
    const mindStat = fs.lstatSync(mindPath, { throwIfNoEntry: false });
    if (!mindStat) return lexicalMindPath;
    if (!mindStat.isFile() || mindStat.isSymbolicLink() || mindStat.nlink !== 1) {
      throw new Error(`Workspace mind is not a regular file: ${id}`);
    }
    const canonicalMind = fs.realpathSync.native(mindPath);
    if (!isContained(workspaceDir, canonicalMind)) {
      throw new Error(`Workspace mind escapes workspace directory: ${id}`);
    }
    return lexicalMindPath;
  }

  /** Mark the given workspace as the default. Throws if id does not exist. */
  setDefault(id: string): void {
    if (!this.get(id)) throw new Error(`Workspace not found: ${id}`);
    const meta = this.loadMeta();
    meta.defaultWorkspace = id;
    this.saveMeta(meta);
  }

  getDefault(): string | null {
    const meta = this.loadMeta();
    return meta.defaultWorkspace ?? null;
  }

  /**
   * Ensure at least one workspace exists. If none, create one called
   * "Default Workspace" and mark it as the default. Idempotent — safe
   * to call on every startup.
   */
  ensureDefault(options?: Partial<CreateWorkspaceOptions>): WorkspaceConfig {
    const existing = this.list();
    if (existing.length > 0) {
      const defaultId = this.getDefault();
      const found = defaultId ? this.get(defaultId) : null;
      return found ?? existing[0];
    }

    const ws = this.create({
      name: options?.name ?? 'Default Workspace',
      group: options?.group ?? 'Personal',
      ...(options?.icon !== undefined && { icon: options.icon }),
      ...(options?.model !== undefined && { model: options.model }),
    });
    this.setDefault(ws.id);
    return ws;
  }

  /**
   * Generate a URL-safe id from a workspace name. Appends -2, -3, … if
   * the slugified name already exists on disk.
   */
  generateId(name: string): string {
    const base = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (!this.workspaceExists(base)) return base;

    let counter = 2;
    while (this.workspaceExists(`${base}-${counter}`)) {
      counter++;
    }
    return `${base}-${counter}`;
  }

  private workspaceExists(id: string): boolean {
    return fs.existsSync(path.join(this.resolveWorkspaceRoot(), id));
  }

  private assertWorkspaceId(id: string): void {
    if (!WORKSPACE_ID.test(id)) throw new Error(`Invalid workspace id: ${id}`);
  }

  private resolveWorkspaceRoot(): string {
    const stat = fs.lstatSync(this.workspacesDir, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Workspace root is not a regular directory');
    }
    const canonicalRoot = fs.realpathSync.native(this.workspacesDir);
    if (canonicalRoot !== this.canonicalWorkspacesDir) {
      throw new Error('Workspace root changed after initialization');
    }
    return canonicalRoot;
  }

  private resolveWorkspaceDir(id: string): string | null {
    this.assertWorkspaceId(id);
    const root = this.resolveWorkspaceRoot();
    const workspacePath = path.join(root, id);
    const stat = fs.lstatSync(workspacePath, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Workspace path is not a regular directory: ${id}`);
    }
    const canonicalWorkspace = fs.realpathSync.native(workspacePath);
    if (!isContained(root, canonicalWorkspace)) {
      throw new Error(`Workspace path escapes workspace root: ${id}`);
    }
    return canonicalWorkspace;
  }

  private resolveConfigPath(id: string): string | null {
    const workspaceDir = this.resolveWorkspaceDir(id);
    if (!workspaceDir) return null;
    const configPath = path.join(workspaceDir, 'workspace.json');
    const stat = fs.lstatSync(configPath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return null;
    const canonicalConfig = fs.realpathSync.native(configPath);
    return isContained(workspaceDir, canonicalConfig) ? canonicalConfig : null;
  }

  private loadMeta(): WorkspacesMeta {
    if (fs.existsSync(this.metaPath)) {
      const raw = fs.readFileSync(this.metaPath, 'utf-8');
      return JSON.parse(raw) as WorkspacesMeta;
    }
    return {};
  }

  private saveMeta(meta: WorkspacesMeta): void {
    fs.writeFileSync(this.metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  }
}
