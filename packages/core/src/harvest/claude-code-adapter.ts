/**
 * Claude Code Filesystem Adapter — reads ~/.claude/ directory structure.
 *
 * Extracts:
 * - memory/*.md files (with frontmatter: type, name, description)
 * - rules/**\/*.md files (coding standards, workflow rules)
 * - plans/*.md files (implementation plans)
 * - settings.json (model preferences, tool config)
 * - CLAUDE.md project files (architectural decisions)
 * - .mind/*.md session handoffs (decisions, directions)
 * - Decision extraction from memory content (pattern matching)
 *
 * This is a FilesystemAdapter — it reads directly from disk.
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FilesystemAdapter, UniversalImportItem, ImportItemType } from './types.js';

// Map Claude Code memory types to our import types
const MEMORY_TYPE_MAP: Record<string, ImportItemType> = {
  user: 'preference',
  feedback: 'decision',
  project: 'memory',
  reference: 'memory',
};

// Patterns that indicate user decisions in text
const DECISION_PATTERNS = [
  /\bwe (?:decided|chose|picked|went with|agreed|confirmed)\b/i,
  /\blet'?s (?:go with|use|do|keep|drop|switch|move)\b/i,
  /\bdecision:\s/i,
  /\bconfirmed:\s/i,
  /\bapproved:\s/i,
  /\brejected:\s/i,
  /\bwon'?t (?:do|use|implement|add|need)\b/i,
  /\bmust (?:use|have|be|support|include)\b/i,
  /\bnon-negotiable\b/i,
  /\brequirement:\s/i,
  /\bconstraint:\s/i,
  /\bchose .+ (?:over|instead of|rather than)\b/i,
  /\bdropped?\b.+\bin favo(?:u)?r of\b/i,
];

interface MemoryFrontmatter {
  name?: string;
  description?: string;
  type?: string;
}

function parseFrontmatter(content: string): { frontmatter: MemoryFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = match[2].trim();
  const frontmatter: MemoryFrontmatter = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === 'name') frontmatter.name = value;
    if (key === 'description') frontmatter.description = value;
    if (key === 'type') frontmatter.type = value;
  }

  return { frontmatter, body };
}

function readFilesRecursive(dir: string, ext: string): { filePath: string; content: string }[] {
  const results: { filePath: string; content: string }[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readFilesRecursive(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      try {
        results.push({ filePath: fullPath, content: fs.readFileSync(fullPath, 'utf-8') });
      } catch { /* skip unreadable files */ }
    }
  }
  return results;
}

export class ClaudeCodeAdapter implements FilesystemAdapter {
  readonly sourceType = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  parse(input: unknown): UniversalImportItem[] {
    // For the SourceAdapter interface — parse JSON if provided
    if (typeof input === 'string') {
      return this.scan(input);
    }
    return [];
  }

  scan(dirPath: string): UniversalImportItem[] {
    if (!fs.existsSync(dirPath)) return [];
    const items: UniversalImportItem[] = [];

    // 1. Scan all project memory directories
    const projectsDir = path.join(dirPath, 'projects');
    if (fs.existsSync(projectsDir)) {
      const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const projEntry of projectEntries) {
        if (!projEntry.isDirectory()) continue;
        const memoryDir = path.join(projectsDir, projEntry.name, 'memory');
        items.push(...this.scanMemoryDir(memoryDir, projEntry.name));
      }
    }

    // 2. Scan rules
    const rulesDir = path.join(dirPath, 'rules');
    const ruleFiles = readFilesRecursive(rulesDir, '.md');
    for (const { filePath, content } of ruleFiles) {
      const relPath = path.relative(dirPath, filePath);
      items.push({
        id: randomUUID(),
        source: 'claude-code',
        type: 'rule',
        title: `Rule: ${path.basename(filePath, '.md')}`,
        content,
        timestamp: this.getFileMtime(filePath),
        metadata: { filePath: relPath, category: 'rule' },
      });
    }

    // 3. Scan plans
    const plansDir = path.join(dirPath, 'plans');
    if (fs.existsSync(plansDir)) {
      const planFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
      for (const planFile of planFiles) {
        const fullPath = path.join(plansDir, planFile);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          items.push({
            id: randomUUID(),
            source: 'claude-code',
            type: 'artifact',
            title: `Plan: ${planFile.replace('.md', '')}`,
            content,
            timestamp: this.getFileMtime(fullPath),
            metadata: { filePath: `plans/${planFile}`, category: 'plan' },
          });
        } catch { /* skip */ }
      }
    }

    // 4. Read settings.json for preferences
    const settingsPath = path.join(dirPath, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      try {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(raw);
        const prefs: string[] = [];
        if (settings.model) prefs.push(`Preferred model: ${settings.model}`);
        if (settings.alwaysThinkingEnabled) prefs.push('Extended thinking: enabled');
        if (Array.isArray(settings.allowedTools)) {
          prefs.push(`Allowed tools: ${settings.allowedTools.length} configured`);
        }
        if (prefs.length > 0) {
          items.push({
            id: randomUUID(),
            source: 'claude-code',
            type: 'preference',
            title: 'Claude Code Settings',
            content: prefs.join('\n'),
            timestamp: this.getFileMtime(settingsPath),
            metadata: { filePath: 'settings.json', category: 'settings' },
          });
        }
      } catch { /* skip */ }
    }

    // 5. Scan CLAUDE.md files from project directories (architectural decisions)
    if (fs.existsSync(projectsDir)) {
      const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const projEntry of projectEntries) {
        if (!projEntry.isDirectory()) continue;
        const claudeMdPath = path.join(projectsDir, projEntry.name, 'CLAUDE.md');
        if (fs.existsSync(claudeMdPath)) {
          try {
            const content = fs.readFileSync(claudeMdPath, 'utf-8');
            if (content.trim().length > 50) {
              items.push({
                id: randomUUID(),
                source: 'claude-code',
                type: 'artifact',
                title: `Project CLAUDE.md (${projEntry.name})`,
                content: content.slice(0, 4000),
                timestamp: this.getFileMtime(claudeMdPath),
                metadata: {
                  filePath: `projects/${projEntry.name}/CLAUDE.md`,
                  category: 'project-config',
                },
              });
            }
          } catch { /* skip */ }
        }
      }
    }

    // 6. Scan .mind/ directories for session handoffs and decisions
    if (fs.existsSync(projectsDir)) {
      const projectEntries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const projEntry of projectEntries) {
        if (!projEntry.isDirectory()) continue;
        const mindDir = path.join(projectsDir, projEntry.name, '.mind');
        items.push(...this.scanMindDir(mindDir, projEntry.name));
      }
    }

    // 7. Extract decisions from memory items that contain decision language
    items.push(...this.extractDecisions(items));

    return items;
  }

  /** Scan .mind/ directory for session handoffs with decisions. */
  private scanMindDir(mindDir: string, projectHash: string): UniversalImportItem[] {
    if (!fs.existsSync(mindDir)) return [];
    const items: UniversalImportItem[] = [];

    try {
      const files = fs.readdirSync(mindDir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const fullPath = path.join(mindDir, file);
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          if (content.trim().length < 50) continue;

          // Determine type from filename
          const lowerFile = file.toLowerCase();
          const isDecision = lowerFile.includes('decision');
          const isState = lowerFile.includes('state');

          items.push({
            id: randomUUID(),
            source: 'claude-code',
            type: isDecision ? 'decision' : 'artifact',
            title: `${isDecision ? 'Decisions' : isState ? 'State' : 'Session'}: ${file.replace('.md', '')}`,
            content: content.slice(0, 4000),
            timestamp: this.getFileMtime(fullPath),
            metadata: {
              filePath: `projects/${projectHash}/.mind/${file}`,
              category: isDecision ? 'decision' : 'session-handoff',
            },
          });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return items;
  }

  /**
   * Extract decision items from existing memory/preference/artifact items.
   * Scans content for decision patterns and creates separate decision items
   * for statements that match. Avoids duplicating items already typed as 'decision'.
   */
  private extractDecisions(existingItems: readonly UniversalImportItem[]): UniversalImportItem[] {
    const decisions: UniversalImportItem[] = [];

    for (const item of existingItems) {
      // Skip items already categorized as decisions
      if (item.type === 'decision' || item.type === 'rule') continue;

      const lines = item.content.split('\n');
      const decisionLines: string[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length < 10) continue;

        for (const pattern of DECISION_PATTERNS) {
          if (pattern.test(trimmed)) {
            decisionLines.push(trimmed);
            break;
          }
        }
      }

      if (decisionLines.length > 0) {
        decisions.push({
          id: randomUUID(),
          source: 'claude-code',
          type: 'decision',
          title: `Decisions from: ${item.title}`,
          content: decisionLines.join('\n'),
          timestamp: item.timestamp,
          metadata: {
            ...item.metadata,
            category: 'decision',
            extractedFrom: item.id,
            decisionCount: decisionLines.length,
          },
        });
      }
    }

    return decisions;
  }

  private scanMemoryDir(memoryDir: string, projectHash: string): UniversalImportItem[] {
    if (!fs.existsSync(memoryDir)) return [];
    const items: UniversalImportItem[] = [];

    const files = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    for (const file of files) {
      const fullPath = path.join(memoryDir, file);
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const { frontmatter, body } = parseFrontmatter(raw);
        if (!body) continue;

        const importType = MEMORY_TYPE_MAP[frontmatter.type ?? ''] ?? 'memory';

        items.push({
          id: randomUUID(),
          source: 'claude-code',
          type: importType,
          title: frontmatter.name ?? file.replace('.md', ''),
          content: body,
          timestamp: this.getFileMtime(fullPath),
          metadata: {
            filePath: `projects/${projectHash}/memory/${file}`,
            memoryType: frontmatter.type,
            description: frontmatter.description,
            category: 'memory',
          },
        });
      } catch { /* skip */ }
    }

    return items;
  }

  private getFileMtime(filePath: string): string {
    try {
      return fs.statSync(filePath).mtime.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
}
