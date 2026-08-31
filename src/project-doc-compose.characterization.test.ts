/**
 * Characterization of the Claude instruction document across the composer swap.
 *
 * The contract is CONTENT EQUIVALENCE, not byte identity: the superseded
 * composer emitted `@` import lines pointing at `.claude-fragments/`, and this
 * one inlines the same sources as `# ` sections. What must not change is which
 * material reaches the agent and in what order.
 *
 * The expected material below was captured from the superseded composer on this
 * branch before the swap. Its one deliberate difference: the old composer sorted
 * every fragment by filename, so `mcp-*` sorted ahead of `module-*`; sections are
 * now grouped by category instead.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-project-doc-characterization-test';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { PERSONA_PREPEND_FILE } from './group-persona.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from './project-doc-compose.js';
import type { AgentGroup } from './types.js';

/** Module instruction docs are identical on this base and the edition trunk. */
const EXPECTED_MODULES = ['agents', 'cli', 'core', 'interactive', 'scheduling', 'self-mod'];

/** Which skills ship resident prose differs per base, so it is read, not named. */
function residentSkills(): string[] {
  const skillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs
    .readdirSync(skillsDir)
    .sort()
    .filter((name) => fs.existsSync(path.join(skillsDir, name, 'instructions.md')));
}

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('Claude instruction document characterization', () => {
  it('carries the same material in the same order as the superseded composer', async () => {
    const ag = {
      id: 'ag-char',
      name: 'char',
      folder: 'char',
      agent_provider: null,
      created_at: new Date().toISOString(),
    } as AgentGroup;
    createAgentGroup(ag);
    ensureContainerConfig(ag.id);
    updateContainerConfigJson(ag.id, 'mcp_servers', {
      weather: { command: 'x', instructions: 'Weather MCP prose.' },
    });

    const groupDir = path.join(TEST_ROOT, ag.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), 'You are an SDR agent.');

    await composeGroupProjectDoc(ag, groupDir, DEFAULT_PROJECT_DOC);
    const doc = fs.readFileSync(path.join(groupDir, DEFAULT_PROJECT_DOC.fileName), 'utf-8');

    // Inlined bodies carry their own `# ` headings, so match the section names
    // this composer emits rather than every top-level heading in the document.
    const SECTION_HEADING =
      /^# (Persona|NanoClaw Runtime Contract|NanoClaw Module: .+|NanoClaw Skill: .+|MCP Server: .+|Omitted for size)$/;
    const headings = doc.split('\n').filter((l) => SECTION_HEADING.test(l));

    expect(headings).toEqual([
      '# Persona',
      '# NanoClaw Runtime Contract',
      ...EXPECTED_MODULES.map((m) => `# NanoClaw Module: ${m}`),
      ...residentSkills().map((s) => `# NanoClaw Skill: ${s}`),
      '# MCP Server: weather',
    ]);
  });
});
