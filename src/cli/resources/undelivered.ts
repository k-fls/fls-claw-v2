/**
 * `ncl undelivered` — the outbound dead-letter surface.
 *
 *   ncl undelivered list                       every permanently-failed reply
 *   ncl undelivered list --agent-group <id>    narrow to one agent group
 *   ncl undelivered requeue --id <message-id>  make one eligible to send again
 *
 * The inbound counterpart is `ncl dropped-messages`, which reports traffic the
 * router refused. This reports replies the agent completed and the host then
 * failed to deliver — the other end of the same pipeline, and until now the
 * silent one.
 *
 * Registered as a resource with only custom operations. The standard CRUD verbs
 * are deliberately left off: `table`/`idColumn` below describe the per-session
 * `delivered` table, which is NOT in the central DB, so the generic SQL handlers
 * have nothing to bind to. Going through `registerResource` anyway is what earns
 * the two properties that matter — the commands carry `resource: 'undelivered'`,
 * so `dispatch.ts`'s group-scope allowlist (groups / sessions / destinations /
 * members) denies them to group-scoped agents; and the resource shows up in
 * `ncl help`, which a bare `register()` command with a `resource` set would not.
 */
import { listUndelivered, requeueUndelivered } from '../../undelivered.js';
import { registerResource } from '../crud.js';

function optionalString(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args[n];
    if (v != null && v !== '' && v !== true) return String(v);
  }
  return undefined;
}

registerResource({
  name: 'undelivered',
  plural: 'undelivered',
  // Per-session inbound.db, not data/v2.db — see the module comment.
  table: 'delivered',
  description:
    'Undelivered replies — agent answers the delivery poll permanently failed to send. A failed row is excluded from redelivery until requeued, so this is the only place such a loss is visible. Read-only listing plus a requeue verb.',
  idColumn: 'message_out_id',
  columns: [
    { name: 'messageOutId', type: 'string', description: 'Outbound message ID. Pass to requeue as --id.' },
    { name: 'sessionId', type: 'string', description: 'Session whose delivery failed.' },
    { name: 'agentGroupId', type: 'string', description: 'Agent group that produced the reply.' },
    { name: 'failedAt', type: 'string', description: 'When the poll gave up.' },
    { name: 'channelType', type: 'string', description: 'Channel the reply was addressed to.' },
    { name: 'platformId', type: 'string', description: 'Platform chat ID the reply was addressed to.' },
    { name: 'preview', type: 'string', description: 'Leading text of the lost reply.' },
    {
      name: 'recoverable',
      type: 'boolean',
      description: 'False when the reply is gone from messages_out — visible, but nothing left to re-send.',
    },
  ],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: 'List replies that permanently failed to deliver, newest first.',
      args: [
        { name: 'agent_group', type: 'string', description: 'Limit the scan to one agent group.' },
        { name: 'limit', type: 'number', description: 'Cap the number of rows returned.' },
      ],
      handler: async (args) => {
        const agentGroupId = optionalString(args, 'agent_group', 'group');
        let limit: number | undefined;
        if (args.limit != null) {
          const n = parseInt(String(args.limit), 10);
          if (!Number.isFinite(n) || n <= 0) throw new Error('--limit expects a positive integer');
          limit = n;
        }
        const messages = listUndelivered({ agentGroupId, limit });
        return { count: messages.length, messages };
      },
    },
    requeue: {
      access: 'open',
      description:
        'Clear one failed delivery so the next poll re-attempts it. Only touches rows marked failed, never delivered ones.',
      args: [
        { name: 'id', type: 'string', description: 'Outbound message ID from `ncl undelivered list`. Required.' },
        { name: 'agent_group', type: 'string', description: 'Limit the lookup to one agent group.' },
      ],
      handler: async (args) => {
        const id = optionalString(args, 'id', 'message', 'message_out_id');
        if (!id) throw new Error('--id <message-out-id> is required (see `ncl undelivered list`)');
        return requeueUndelivered(id, { agentGroupId: optionalString(args, 'agent_group', 'group') });
      },
    },
  },
});
