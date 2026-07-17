import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks ---

vi.mock('../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockGetContainerConfig = vi.fn();
vi.mock('../db/container-configs.js', () => ({
  getContainerConfig: (...args: unknown[]) => mockGetContainerConfig(...args),
}));

const mockGetAgentGroup = vi.fn();
vi.mock('../db/agent-groups.js', () => ({
  getAgentGroup: (...args: unknown[]) => mockGetAgentGroup(...args),
}));

const mockGetSession = vi.fn();
vi.mock('../db/sessions.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

// dispatch's post-handler looks up the resource's `scopeField` via getResource.
// The real resources aren't registered in this unit test, so mock it.
const mockGetResource = vi.fn();
vi.mock('./crud.js', () => ({
  getResource: (...args: unknown[]) => mockGetResource(...args),
}));

const approvalState = vi.hoisted(() => ({
  requestApproval: vi.fn(),
  cliCommandHandler: null as
    | null
    | ((args: {
        session: unknown;
        payload: Record<string, unknown>;
        userId: string;
        notify: (text: string) => void;
      }) => Promise<void>),
}));
vi.mock('../modules/approvals/index.js', () => ({
  registerApprovalHandler: vi.fn((action: string, handler: typeof approvalState.cliCommandHandler) => {
    if (action === 'cli_command') approvalState.cliCommandHandler = handler;
  }),
  requestApproval: approvalState.requestApproval,
}));

// dispatch re-verifies role-change approvers at apply time via these.
const roleState = vi.hoisted(() => ({ owners: new Set<string>(), globalAdmins: new Set<string>() }));
vi.mock('../modules/permissions/db/user-roles.js', () => ({
  isOwner: (u: string) => roleState.owners.has(u),
  isGlobalAdmin: (u: string) => roleState.globalAdmins.has(u),
}));

// Register a test command so dispatch has something to find
import { register } from './registry.js';

register({
  name: 'test-cmd',
  description: 'test command (non-group resource)',
  resource: 'test',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'groups-test',
  description: 'test command (groups resource)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'general-cmd',
  description: 'test command (no resource, like help)',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'sessions-list',
  description: 'test command (sessions resource)',
  resource: 'sessions',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'destinations-list',
  description: 'test command (destinations resource)',
  resource: 'destinations',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'members-add',
  description: 'test command (members resource)',
  resource: 'members',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

register({
  name: 'wirings-list',
  description: 'test command (wirings resource — not allowed)',
  resource: 'wirings',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ echo: args }),
});

// Role grant/revoke — privilege-sensitive, approval-gated. Used by the
// approval-routing tests below.
register({
  name: 'roles-grant',
  description: 'grant a role (approval-gated)',
  resource: 'roles',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ granted: args }),
});
register({
  name: 'roles-revoke',
  description: 'revoke a role (approval-gated)',
  resource: 'roles',
  access: 'approval',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ revoked: args }),
});

// Commands that return data shaped like real resources (for post-handler filtering tests)
register({
  name: 'groups-list-data',
  description: 'returns mock group rows',
  resource: 'groups',
  access: 'open',
  generic: 'list',
  parseArgs: (raw) => raw,
  handler: async () => [
    { id: 'g1', name: 'my-group' },
    { id: 'g2', name: 'other-group' },
  ],
});

register({
  name: 'sessions-get-data',
  description: 'returns a mock session row',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({
    id: args.id,
    agent_group_id: (args as Record<string, unknown>).belongs_to ?? 'g1',
  }),
});

// A custom op under the `groups` resource that returns a config-shaped object
// (no `id` key). The post-handler must not touch this — only `generic` handlers.
register({
  name: 'groups-config-get',
  description: 'custom op returning a config object (no id)',
  resource: 'groups',
  access: 'open',
  parseArgs: (raw) => raw,
  handler: async () => ({ agent_group_id: 'g1', model: 'opus' }),
});

// The real `sessions-get` name — triggers the pre-handler ownership check.
register({
  name: 'sessions-get',
  description: 'generic sessions get',
  resource: 'sessions',
  access: 'open',
  generic: 'get',
  parseArgs: (raw) => raw,
  handler: async (args) => ({ id: (args as Record<string, unknown>).id, agent_group_id: 'g1' }),
});

import { dispatch } from './dispatch.js';
import type { CallerContext } from './frame.js';

beforeEach(() => {
  vi.clearAllMocks();
  roleState.owners.clear();
  roleState.globalAdmins.clear();
  // Default: the four CLI-whitelisted resources with their real scopeFields.
  const scopeFields: Record<string, string> = {
    groups: 'id',
    sessions: 'agent_group_id',
    destinations: 'agent_group_id',
    members: 'agent_group_id',
  };
  mockGetResource.mockImplementation((plural: string) =>
    scopeFields[plural] ? { scopeField: scopeFields[plural] } : undefined,
  );
});

// --- Helpers ---

function agentCtx(overrides?: Partial<Extract<CallerContext, { caller: 'agent' }>>): CallerContext {
  return {
    caller: 'agent',
    sessionId: 's1',
    agentGroupId: 'g1',
    messagingGroupId: 'mg1',
    ...overrides,
  };
}

// --- Tests ---

describe('CLI scope enforcement', () => {
  it('disabled: rejects all CLI requests from agent', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'disabled' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('disabled');
    }
  });

  it('group: auto-fills --id with caller agent group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: rejects cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('scoped');
    }
  });

  it('group: allows same-group id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { id: 'g1' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: blocks cli_scope escalation', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { cli_scope: 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('cli_scope');
    }
  });

  it('group: blocks cli-scope escalation (hyphenated)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-test', args: { 'cli-scope': 'global' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: blocks non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('test');
    }
  });

  it('group: allows general commands with no resource (e.g. help)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'general-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('group: allows sessions, auto-fills --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'sessions-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.agent_group_id).toBe('g1');
      // --id should NOT be auto-filled for sessions (it's session UUID, not group)
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('group: allows destinations, auto-fills --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'destinations-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBe('g1');
    }
  });

  it('group: allows members, auto-fills --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'members-add', args: { user: 'u1' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.group).toBe('g1');
    }
  });

  it('group: blocks non-whitelisted resources (wirings)', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'wirings-list', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('wirings');
    }
  });

  it('group: rejects cross-group --agent_group_id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-list', args: { agent_group_id: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('group: rejects cross-group --group', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'members-add', args: { user: 'u1', group: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('global: allows cross-group access', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'other-group' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: allows non-group resources', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  it('global: does not auto-fill --id', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { foo: 'bar' } }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as { echo: Record<string, unknown> };
      expect(data.echo.id).toBeUndefined();
    }
  });

  it('defaults to group when cli_scope is missing', async () => {
    mockGetContainerConfig.mockReturnValue({});

    const resp = await dispatch({ id: '1', command: 'test-cmd', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
    }
  });

  it('host caller bypasses CLI scope enforcement', async () => {
    // No config check should happen for host callers
    const resp = await dispatch({ id: '1', command: 'test-cmd', args: { id: 'any-group' } }, { caller: 'host' });

    expect(resp.ok).toBe(true);
    expect(mockGetContainerConfig).not.toHaveBeenCalled();
  });

  // --- Post-handler filtering ---

  it('group: groups list filters out other groups', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('g1');
    }
  });

  it('group: sessions get rejects cross-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'other-group' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('different agent group');
    }
  });

  it('group: sessions get allows own-group session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    const resp = await dispatch(
      { id: '1', command: 'sessions-get-data', args: { id: 's-123', belongs_to: 'g1' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(true);
  });

  it('global: no post-handler filtering', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      const data = resp.data as Array<{ id: string }>;
      expect(data).toHaveLength(2); // both groups returned
    }
  });

  // --- Custom ops bypass post-handler row filtering (regression: #2392 review) ---

  it('group: a custom op returning a non-row object is not falsely rejected', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });

    // groups-config-get is access:open and reachable by a group-scoped agent;
    // it returns { agent_group_id, model } with no `id` field. Before this fix
    // the post-handler compared data['id'] (undefined) and returned forbidden.
    const resp = await dispatch({ id: '1', command: 'groups-config-get', args: {} }, agentCtx());

    expect(resp.ok).toBe(true);
    if (resp.ok) {
      expect((resp.data as { model: string }).model).toBe('opus');
    }
  });

  // --- sessions-get pre-handler ownership check (no existence oracle) ---

  it('group: sessions-get returns "session not found" for a foreign session UUID', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's-x', agent_group_id: 'other-group' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-x' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('group: sessions-get returns "session not found" for a non-existent UUID', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue(undefined);

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-nope' } }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('handler-error');
      expect(resp.error.message).toContain('session not found');
    }
  });

  it('group: sessions-get allows the caller’s own session', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetSession.mockReturnValue({ id: 's-mine', agent_group_id: 'g1' });

    const resp = await dispatch({ id: '1', command: 'sessions-get', args: { id: 's-mine' } }, agentCtx());

    expect(resp.ok).toBe(true);
  });

  // --- Fail-closed regression guard for a missing scopeField ---

  it('group: generic list/get fails closed when the resource declares no scopeField', async () => {
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'group' });
    mockGetResource.mockReturnValue(undefined); // a whitelisted resource that forgot scopeField

    const resp = await dispatch({ id: '1', command: 'groups-list-data', args: {} }, agentCtx());

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.error.code).toBe('forbidden');
      expect(resp.error.message).toContain('not available in group scope');
    }
  });
});

// ---------------------------------------------------------------------------
// Role-change approval routing (privilege-proportional, target-excluded)
// ---------------------------------------------------------------------------

describe('role-change approval routing', () => {
  function constraintOf(): { minLevel?: string; excludeUserIds?: string[] } | undefined {
    const call = approvalState.requestApproval.mock.calls[0]?.[0] as { approverConstraint?: unknown } | undefined;
    return call?.approverConstraint as { minLevel?: string; excludeUserIds?: string[] } | undefined;
  }

  beforeEach(() => {
    // Role commands are only reachable in global CLI scope.
    mockGetContainerConfig.mockReturnValue({ cli_scope: 'global' });
    mockGetSession.mockReturnValue({ id: 's1', agent_group_id: 'g1', messaging_group_id: 'mg1' });
    mockGetAgentGroup.mockReturnValue({ id: 'g1', name: 'Group One' });
  });

  it('grant global admin (no --group): requires an OWNER approver, target excluded', async () => {
    const resp = await dispatch(
      { id: '1', command: 'roles-grant', args: { user: 'telegram:victim', role: 'admin' } },
      agentCtx(),
    );

    expect(resp.ok).toBe(false);
    if (!resp.ok) expect(resp.error.code).toBe('approval-pending');
    expect(constraintOf()).toEqual({ minLevel: 'owner', excludeUserIds: ['telegram:victim'] });
  });

  it('grant owner: requires an OWNER approver', async () => {
    await dispatch({ id: '1', command: 'roles-grant', args: { user: 'telegram:x', role: 'owner' } }, agentCtx());
    expect(constraintOf()).toEqual({ minLevel: 'owner', excludeUserIds: ['telegram:x'] });
  });

  it('revoke group-scoped admin (--group): a GLOBAL admin (or owner) may approve', async () => {
    await dispatch(
      { id: '1', command: 'roles-revoke', args: { user: 'telegram:x', role: 'admin', group: 'g1' } },
      agentCtx(),
    );
    expect(constraintOf()).toEqual({ minLevel: 'global-admin', excludeUserIds: ['telegram:x'] });
  });

  it('unknown/garbled role fails strict (requires owner)', async () => {
    await dispatch({ id: '1', command: 'roles-grant', args: { user: 'telegram:x' } }, agentCtx());
    expect(constraintOf()).toEqual({ minLevel: 'owner', excludeUserIds: ['telegram:x'] });
  });

  it('non-role approval command carries NO approverConstraint (legacy routing unchanged)', async () => {
    // groups-config-set-style approval command: register one on the fly.
    register({
      name: 'widgets-frob',
      description: 'a non-role approval command',
      resource: 'widgets',
      access: 'approval',
      parseArgs: (raw) => raw,
      handler: async (args) => ({ ok: args }),
    });
    await dispatch({ id: '1', command: 'widgets-frob', args: { x: 1 } }, agentCtx());
    expect(constraintOf()).toBeUndefined();
    const payload = approvalState.requestApproval.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(payload.payload.approverConstraint).toBeUndefined();
  });

  // --- apply-time re-verification (mirrors #2566) ---

  it('apply time: a demoted/unqualified approver cannot apply the change', async () => {
    await dispatch({ id: '1', command: 'roles-grant', args: { user: 'telegram:victim', role: 'admin' } }, agentCtx());
    const payload = (approvalState.requestApproval.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;

    expect(approvalState.cliCommandHandler).toBeTypeOf('function');
    const notify = vi.fn();
    // 'telegram:notowner' holds no owner role → must be rejected at apply.
    await approvalState.cliCommandHandler!({ session: {}, payload, userId: 'telegram:notowner', notify });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('NOT applied');
  });

  it('apply time: the target cannot apply their own change even if still owner', async () => {
    roleState.owners.add('telegram:victim'); // still an owner, but is the target
    await dispatch({ id: '1', command: 'roles-revoke', args: { user: 'telegram:victim', role: 'owner' } }, agentCtx());
    const payload = (approvalState.requestApproval.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;

    const notify = vi.fn();
    await approvalState.cliCommandHandler!({ session: {}, payload, userId: 'telegram:victim', notify });

    expect(notify.mock.calls[0][0]).toContain('NOT applied');
    expect(notify.mock.calls[0][0]).toContain('self-approval');
  });

  it('apply time: a qualified owner applies the change (re-dispatched as host)', async () => {
    roleState.owners.add('telegram:realowner');
    await dispatch({ id: '1', command: 'roles-grant', args: { user: 'telegram:victim', role: 'admin' } }, agentCtx());
    const payload = (approvalState.requestApproval.mock.calls[0][0] as { payload: Record<string, unknown> }).payload;

    const notify = vi.fn();
    await approvalState.cliCommandHandler!({ session: {}, payload, userId: 'telegram:realowner', notify });

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('approved and executed');
  });
});
