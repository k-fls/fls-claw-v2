/**
 * SSH MCP tools.
 *
 * Port of the +115 LOC SSH section from v1's `ipc-mcp-stdio.ts`. The tool
 * function bodies are byte-identical to v1 (modulo `server.tool(...)` →
 * `McpToolDefinition` shape). They call the host-rpc `/ssh/*` endpoints
 * exposed by the host's ssh-auth module via `CLAW_HOST_RPC_URL`.
 *
 * Three tools:
 *   - ssh_request_credential: ask the user (or auto-generate) for SSH creds
 *   - ssh_connect: establish a ControlMaster connection
 *   - ssh_disconnect: tear down a ControlMaster connection
 *
 * The agent never sees credentials. Connections route through a
 * pre-authenticated socket at `/ssh-sockets/<alias>.sock` (the bind mount
 * registered as a host-side A3 contribution).
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const HOST_RPC_URL = process.env.CLAW_HOST_RPC_URL;
if (!HOST_RPC_URL) {
  throw new Error(
    'CLAW_HOST_RPC_URL is not set — SSH tools cannot reach the host. ' +
      'Ensure ssh-auth A3 contribution is wired and host-rpc server started before container spawn.',
  );
}

async function sshProxyCall(endpoint: string, body: object): Promise<any> {
  try {
    const res = await fetch(`${HOST_RPC_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      return {
        status: 'error',
        error: parsed.error || res.statusText || `HTTP ${res.status}`,
      };
    }
    // v2 host-rpc wraps successful responses in { ok:true, result: <body> }.
    // The v1 wire shape (status:'ok'/'error', ...) lives inside `result`.
    return parsed.result ?? parsed;
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const sshRequestCredential: McpToolDefinition = {
  tool: {
    name: 'ssh_request_credential',
    description:
      'Request SSH credentials from the user. Two modes:\n' +
      '• "generate": Generate an ed25519 keypair on the host. Returns the public key for the user to add to authorized_keys.\n' +
      '• "ask": Notify the user to provide credentials via /ssh add. Returns "pending" — you\'ll receive a system message when fulfilled.\n\n' +
      'If the credential already exists, returns { status: "ok" } regardless of mode.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: { type: 'string', description: 'Credential alias (e.g., "prod-db", "staging")' },
        mode: { type: 'string', enum: ['generate', 'ask'], description: 'generate=create keypair, ask=request from user' },
        connection_host: { type: 'string', description: 'Remote host to connect to' },
        connection_port: { type: 'number', description: 'SSH port (default 22)' },
        connection_username: { type: 'string', description: 'SSH username (required for generate mode)' },
      },
      required: ['alias', 'mode', 'connection_host'],
    },
  },
  async handler(args) {
    const result = await sshProxyCall('/ssh/request-credential', {
      alias: args.alias,
      mode: args.mode,
      connection_host: args.connection_host,
      connection_port: args.connection_port,
      connection_username: args.connection_username,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: result.status === 'error',
    };
  },
};

export const sshConnect: McpToolDefinition = {
  tool: {
    name: 'ssh_connect',
    description:
      'Establish an SSH connection to a remote server using stored credentials.\n' +
      'The connection is multiplexed via ControlMaster — after connecting, use standard ssh/scp/rsync commands with the provided ControlPath socket.\n' +
      'Returns usage examples on success.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: { type: 'string', description: 'Credential alias to connect with' },
        timeout: { type: 'number', description: 'Connection timeout in seconds (default 5)' },
      },
      required: ['alias'],
    },
  },
  async handler(args) {
    const result = await sshProxyCall('/ssh/connect', {
      alias: args.alias,
      timeout: args.timeout,
    });
    if (result.status === 'ok') {
      return { content: [{ type: 'text' as const, text: result.usage as string }] };
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: true,
    };
  },
};

export const sshDisconnect: McpToolDefinition = {
  tool: {
    name: 'ssh_disconnect',
    description: 'Disconnect an SSH ControlMaster connection.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: { type: 'string', description: 'Credential alias to disconnect' },
      },
      required: ['alias'],
    },
  },
  async handler(args) {
    const result = await sshProxyCall('/ssh/disconnect', { alias: args.alias });
    return {
      content: [
        {
          type: 'text' as const,
          text:
            result.status === 'ok'
              ? `Disconnected '${args.alias}'.`
              : JSON.stringify(result),
        },
      ],
      isError: result.status === 'error',
    };
  },
};

registerTools([sshRequestCredential, sshConnect, sshDisconnect]);
