/**
 * Auth-provider MCP tools.
 *
 * `reload_auth_providers` re-loads this container's per-container auth
 * provider tier from `/workspace/agent/.auth-discovery/` without a restart.
 * Edit or add a provider def file in that (hidden, dot-prefixed) directory,
 * then call this tool to make the change take effect immediately. The host
 * re-runs the loader (same safety filters as at container start) and reports
 * which providers were installed and which were rejected, with reasons — also
 * written back to the directory as `_load-report.json`.
 *
 * Backed by the `reload_auth_providers` host sync action (see
 * `src/modules/mitm-proxy/reload-providers-action.ts`).
 */
import { callSyncAction } from '../sync-action.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

interface ReloadResult {
  registered: string[];
  rejected: Array<{ id: string; reason: string }>;
}

export const reloadAuthProviders: McpToolDefinition = {
  tool: {
    name: 'reload_auth_providers',
    description:
      "Reload this group's auth provider definitions from its " +
      '/workspace/agent/.auth-discovery/ directory, applying edits/additions ' +
      'without a container restart. Call after changing a provider def file. ' +
      'Returns the installed providers and any that were rejected (with reasons); ' +
      'the same report is written to .auth-discovery/_load-report.json.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  async handler() {
    try {
      const result = (await callSyncAction('reload_auth_providers', {})) as ReloadResult;
      const registered = result.registered ?? [];
      const rejected = result.rejected ?? [];

      log(`reload_auth_providers: ${registered.length} registered, ${rejected.length} rejected`);

      const lines: string[] = [];
      lines.push(
        registered.length > 0
          ? `Installed ${registered.length} provider(s): ${registered.join(', ')}.`
          : 'No providers installed.',
      );
      if (rejected.length > 0) {
        lines.push(`Rejected ${rejected.length}:`);
        for (const r of rejected) lines.push(`  - ${r.id}: ${r.reason}`);
      }
      return ok(lines.join('\n'));
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([reloadAuthProviders]);
