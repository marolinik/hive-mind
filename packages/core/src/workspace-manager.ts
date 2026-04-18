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
  private readonly metaPath: string;

  constructor(baseDir: string) {
    this.workspacesDir = path.join(baseDir, 'workspaces');
    this.metaPath = path.join(baseDir, 'workspaces-meta.json');

    if (!fs.existsSync(this.workspacesDir)) {
      fs.mkdirSync(this.workspacesDir, { recursive: true });
    }
  }

  /** Create a new workspace directory, empty .mind file, and workspace.json. */
  create(options: CreateWorkspaceOptions): WorkspaceConfig {
    const id = this.generateId(options.name);
    const wsDir = path.join(this.workspacesDir, id);

    fs.mkdirSync(wsDir, { recursive: true });
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

  /** List every workspace by reading workspace.json from each subdirectory. */
  list(): WorkspaceConfig[] {
    if (!fs.existsSync(this.workspacesDir)) return [];

    const entries = fs.readdirSync(this.workspacesDir, { withFileTypes: true });
    const configs: WorkspaceConfig[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const configPath = path.join(this.workspacesDir, entry.name, 'workspace.json');
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf-8');
        configs.push(JSON.parse(raw) as WorkspaceConfig);
      }
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
    const configPath = path.join(this.workspacesDir, id, 'workspace.json');
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as WorkspaceConfig;
  }

  update(id: string, updates: Partial<Omit<WorkspaceConfig, 'id' | 'created'>>): void {
    const existing = this.get(id);
    if (!existing) throw new Error(`Workspace not found: ${id}`);

    const updated = { ...existing, ...updates };
    const configPath = path.join(this.workspacesDir, id, 'workspace.json');
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf-8');
  }

  delete(id: string): void {
    const wsDir = path.join(this.workspacesDir, id);
    if (fs.existsSync(wsDir)) {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  }

  /** Absolute path to a workspace's .mind file. */
  getMindPath(id: string): string {
    return path.join(this.workspacesDir, id, 'workspace.mind');
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
    return fs.existsSync(path.join(this.workspacesDir, id));
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
