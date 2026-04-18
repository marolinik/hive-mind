import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClaudeCodeAdapter } from './claude-code-adapter.js';

describe('ClaudeCodeAdapter', () => {
  const adapter = new ClaudeCodeAdapter();
  let root: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hmind-claude-code-'));
  });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('parse() with non-string input returns []', () => {
    expect(adapter.parse(null)).toEqual([]);
    expect(adapter.parse({})).toEqual([]);
    expect(adapter.parse(123)).toEqual([]);
  });

  it('scan() on a non-existent directory returns []', () => {
    const items = adapter.scan(path.join(root, 'does-not-exist'));
    expect(items).toEqual([]);
  });

  it('scan() on an empty directory returns []', () => {
    const empty = path.join(root, 'empty');
    fs.mkdirSync(empty);
    expect(adapter.scan(empty)).toEqual([]);
  });

  it('reads memory frontmatter and maps user→preference / feedback→decision / project→memory', () => {
    const dir = path.join(root, 'memory-test');
    const projectMemDir = path.join(dir, 'projects', 'proj-abc', 'memory');
    fs.mkdirSync(projectMemDir, { recursive: true });

    fs.writeFileSync(path.join(projectMemDir, 'user.md'),
      '---\nname: User Role\ndescription: role info\ntype: user\n---\nUser is a senior engineer.',
    );
    fs.writeFileSync(path.join(projectMemDir, 'feedback.md'),
      '---\nname: Feedback Rule\ntype: feedback\n---\nUse integration tests, not mocks.',
    );
    fs.writeFileSync(path.join(projectMemDir, 'project.md'),
      '---\nname: Launch\ntype: project\n---\nLaunch freeze on Thursday.',
    );
    // MEMORY.md should be skipped
    fs.writeFileSync(path.join(projectMemDir, 'MEMORY.md'), '- index only');

    const items = adapter.scan(dir);
    const memItems = items.filter((i) => i.metadata.category === 'memory');
    const titles = memItems.map((i) => i.title).sort();
    expect(titles).toEqual(['Feedback Rule', 'Launch', 'User Role']);

    const byTitle = Object.fromEntries(memItems.map((i) => [i.title, i]));
    expect(byTitle['User Role'].type).toBe('preference');
    expect(byTitle['Feedback Rule'].type).toBe('decision');
    expect(byTitle['Launch'].type).toBe('memory');
  });

  it('defaults memory to type "memory" when frontmatter is absent', () => {
    const dir = path.join(root, 'memory-default');
    const memDir = path.join(dir, 'projects', 'p', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'note.md'), 'Just a raw note with no frontmatter.');

    const items = adapter.scan(dir);
    const note = items.find((i) => i.title === 'note');
    expect(note).toBeDefined();
    expect(note!.type).toBe('memory');
    expect(note!.content).toBe('Just a raw note with no frontmatter.');
  });

  it('scans rules/ recursively and emits rule items', () => {
    const dir = path.join(root, 'rules-test');
    const deepRules = path.join(dir, 'rules', 'typescript');
    fs.mkdirSync(deepRules, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rules', 'style.md'), '# Style rules');
    fs.writeFileSync(path.join(deepRules, 'testing.md'), '# TS testing rules');

    const items = adapter.scan(dir);
    const ruleItems = items.filter((i) => i.type === 'rule');
    expect(ruleItems).toHaveLength(2);
    const titles = ruleItems.map((i) => i.title).sort();
    expect(titles).toEqual(['Rule: style', 'Rule: testing']);
  });

  it('reads plans/*.md as artifact items', () => {
    const dir = path.join(root, 'plans-test');
    const plansDir = path.join(dir, 'plans');
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, 'roadmap-q2.md'), '# Q2 roadmap');

    const items = adapter.scan(dir);
    const plan = items.find((i) => i.title === 'Plan: roadmap-q2');
    expect(plan).toBeDefined();
    expect(plan!.type).toBe('artifact');
    expect(plan!.metadata.category).toBe('plan');
  });

  it('reads settings.json and produces a preference item with model/tools', () => {
    const dir = path.join(root, 'settings-test');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        model: 'opus',
        alwaysThinkingEnabled: true,
        allowedTools: ['Read', 'Write', 'Bash'],
      }),
    );

    const items = adapter.scan(dir);
    expect(items).toHaveLength(1);
    const pref = items[0];
    expect(pref.type).toBe('preference');
    expect(pref.title).toBe('Claude Code Settings');
    expect(pref.content).toContain('Preferred model: opus');
    expect(pref.content).toContain('Extended thinking: enabled');
    expect(pref.content).toContain('3 configured');
  });

  it('skips malformed settings.json without throwing', () => {
    const dir = path.join(root, 'bad-settings');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not: json }');
    expect(() => adapter.scan(dir)).not.toThrow();
    expect(adapter.scan(dir)).toEqual([]);
  });

  it('reads per-project CLAUDE.md as an artifact tagged project-config', () => {
    const dir = path.join(root, 'claude-md-test');
    const projRoot = path.join(dir, 'projects', 'myproj');
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(
      path.join(projRoot, 'CLAUDE.md'),
      '# My Project\n\nThis is the long-form project context required to be imported.',
    );

    const items = adapter.scan(dir);
    const claudeMd = items.find((i) => i.metadata.category === 'project-config');
    expect(claudeMd).toBeDefined();
    expect(claudeMd!.type).toBe('artifact');
    expect(claudeMd!.title).toBe('Project CLAUDE.md (myproj)');
  });

  it('ignores CLAUDE.md files shorter than the 50-char threshold', () => {
    const dir = path.join(root, 'short-claude-md');
    const projRoot = path.join(dir, 'projects', 'tiny');
    fs.mkdirSync(projRoot, { recursive: true });
    fs.writeFileSync(path.join(projRoot, 'CLAUDE.md'), 'too short');

    const items = adapter.scan(dir);
    const claudeMd = items.find((i) => i.metadata.category === 'project-config');
    expect(claudeMd).toBeUndefined();
  });

  it('detects decision-labeled files in .mind/ and marks them decision type', () => {
    const dir = path.join(root, 'mind-test');
    const mindDir = path.join(dir, 'projects', 'proj', '.mind');
    fs.mkdirSync(mindDir, { recursive: true });
    fs.writeFileSync(
      path.join(mindDir, 'decisions-log.md'),
      '- we chose Postgres over MySQL\n- we decided to drop the legacy API',
    );
    fs.writeFileSync(
      path.join(mindDir, 'STATE.md'),
      'Current sprint: wave 3c in progress, harvest pipeline about to land.',
    );

    const items = adapter.scan(dir);
    const mindItems = items.filter((i) => i.metadata.category === 'decision' || i.metadata.category === 'session-handoff');
    const decisionItem = mindItems.find((i) => i.metadata.category === 'decision' && i.title.startsWith('Decisions:'));
    const stateItem = mindItems.find((i) => i.metadata.category === 'session-handoff' && i.title.startsWith('State:'));
    expect(decisionItem).toBeDefined();
    expect(decisionItem!.type).toBe('decision');
    expect(stateItem).toBeDefined();
    expect(stateItem!.type).toBe('artifact');
  });

  it('synthesizes decision items from memory content matching decision patterns', () => {
    const dir = path.join(root, 'decision-extract');
    const memDir = path.join(dir, 'projects', 'p', 'memory');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(
      path.join(memDir, 'log.md'),
      '---\nname: Sprint log\ntype: project\n---\n' +
        'Some background narrative that is not a decision.\n' +
        'We chose Rust over Go for the ingestion layer.\n' +
        'Decision: ship behind a feature flag.\n' +
        'Unrelated paragraph about coffee.',
    );

    const items = adapter.scan(dir);
    const extracted = items.find((i) => i.type === 'decision' && i.title.startsWith('Decisions from:'));
    expect(extracted).toBeDefined();
    expect(extracted!.content).toMatch(/We chose Rust over Go/);
    expect(extracted!.content).toMatch(/Decision: ship behind a feature flag/);
    expect(extracted!.content).not.toMatch(/coffee/);
    expect(extracted!.metadata.decisionCount).toBe(2);
  });

  it('never synthesizes decision items from rule items (to avoid duplication)', () => {
    const dir = path.join(root, 'rule-decision');
    const rulesDir = path.join(dir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, 'r.md'),
      '- we must use parameterized queries\n- decision: never log secrets',
    );

    const items = adapter.scan(dir);
    // Only the rule item, no synthesized decision item
    expect(items.filter((i) => i.type === 'rule')).toHaveLength(1);
    expect(items.filter((i) => i.type === 'decision')).toHaveLength(0);
  });

  it('parse() forwards string input to scan()', () => {
    const dir = path.join(root, 'parse-delegate');
    const rulesDir = path.join(dir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(path.join(rulesDir, 'x.md'), '# rule');

    const items = adapter.parse(dir);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Rule: x');
  });
});
