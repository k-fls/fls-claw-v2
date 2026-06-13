/**
 * Credential MCP tools.
 *
 * `get_credential` pulls a substitute token for a provider whose real
 * credential lives on the host. The token returned is a **substitute** — a
 * placeholder the MITM proxy swaps for the real secret at request time, so the
 * agent never holds the real value. Use the substitute exactly where the real
 * token would go (Authorization header, CLI flag, env var); the swap happens in
 * flight.
 *
 * Backed by the `get_credential` host sync action (see
 * `src/modules/sync-actions/` and `src/modules/mitm-proxy/get-credential-action.ts`).
 */
import { publishEnvVar } from '../env-vars.js';
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

interface SubstituteResult {
  substitute: string;
  providerId: string;
  credentialPath: string;
  envNames: string[];
}

export const getCredential: McpToolDefinition = {
  tool: {
    name: 'get_credential',
    description:
      'Pull a substitute token for a stored credential. The returned value is a ' +
      'placeholder the proxy swaps for the real secret at request time — use it ' +
      'wherever the real token would go; never expect it to look like the real ' +
      'secret. Useful for a provider whose credential was added after this ' +
      'session started, or that has no automatic env injection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        providerId: {
          type: 'string',
          description: 'Provider id, e.g. "github", "todoist". Must match a provider known to the proxy.',
        },
        credentialPath: {
          type: 'string',
          description: 'Credential type: "oauth" for OAuth tokens, "api_key" for API keys.',
        },
        envVar: {
          type: 'string',
          description:
            'Optional env var name to publish the substitute as (UPPER_SNAKE_CASE). ' +
            'Reserved system names are rejected.',
        },
      },
      required: ['providerId', 'credentialPath'],
    },
  },
  async handler(args) {
    const providerId = args.providerId as string;
    const credentialPath = args.credentialPath as string;
    const envVar = (args.envVar as string | undefined) || undefined;
    if (!providerId) return err('providerId is required');
    if (!credentialPath) return err('credentialPath is required');

    try {
      const result = (await callSyncAction('get_credential', {
        providerId,
        credentialPath,
        ...(envVar ? { envVar } : {}),
      })) as SubstituteResult;

      // Publish into the session's BASH_ENV file so subsequent Bash calls pick
      // it up. Only the explicitly requested name is published here (the host
      // already validated/rejected reserved or malformed names).
      let publishedNote = '';
      if (envVar) {
        publishEnvVar(envVar, result.substitute);
        publishedNote = ` Published as $${envVar} for subsequent Bash calls.`;
      }

      log(`get_credential: ${providerId}/${credentialPath}${envVar ? ` → $${envVar}` : ''}`);
      return ok(
        `Substitute token for ${providerId} (${credentialPath}): ${result.substitute}\n` +
          `Use this value as the credential; the proxy swaps it for the real secret in flight.${publishedNote}`,
      );
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  },
};

registerTools([getCredential]);
