import { randomUUID } from 'crypto';

import { createMessagingGroupAgent } from '../../db/messaging-groups.js';
import type { MessagingGroupAgent } from '../../types.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'wiring',
  plural: 'wirings',
  table: 'messaging_group_agents',
  description:
    'Wiring — connects a messaging group to an agent group. Determines which agent handles messages from which chat. The same messaging group can be wired to multiple agents; the same agent can be wired to multiple messaging groups.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'The chat/channel to route from. References messaging_groups.id.',
      required: true,
    },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent that handles messages. References agent_groups.id.',
      required: true,
    },
    {
      name: 'engage_mode',
      type: 'string',
      description:
        'When the agent engages. "mention" — only when @mentioned or in DMs. "mention-sticky" — once mentioned in a thread, the agent subscribes and responds to all subsequent messages in that thread without needing further mentions. "pattern" — matches every message against engage_pattern regex.',
      enum: ['pattern', 'mention', 'mention-sticky'],
      default: 'mention',
      updatable: true,
    },
    {
      name: 'engage_pattern',
      type: 'string',
      description:
        'Regex for engage_mode=pattern. Required when mode is pattern. Use "." to match every message (always-on). Ignored for mention modes.',
      updatable: true,
    },
    {
      name: 'sender_scope',
      type: 'string',
      description:
        '"all" — any sender (subject to unknown_sender_policy). "known" — only users with a role or membership in this agent group.',
      enum: ['all', 'known'],
      default: 'all',
      updatable: true,
    },
    {
      name: 'ignored_message_policy',
      type: 'string',
      description:
        'What happens to messages that don\'t trigger engagement. "drop" — agent never sees them. "accumulate" — stored as background context (trigger=0) so the agent has prior context when eventually triggered.',
      enum: ['drop', 'accumulate'],
      default: 'drop',
      updatable: true,
    },
    {
      name: 'session_mode',
      type: 'string',
      description:
        '"shared" — one session per (agent, messaging group). "per-thread" — separate session per thread/topic. "agent-shared" — one session across all messaging groups wired to this agent. Note: threaded adapters in group chats force per-thread regardless of this setting.',
      enum: ['shared', 'per-thread', 'agent-shared'],
      default: 'shared',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // `create` is intentionally not in `operations` — the generic single-table
  // INSERT bypasses the domain helper `createMessagingGroupAgent`, which also
  // auto-creates the matching `agent_destinations` row so the agent can deliver
  // to the wired chat as a target. Without it, `destinations list` is empty and
  // the agent's `<message to="...">` blocks get dropped (#5). The custom handler
  // below routes through `createMessagingGroupAgent` instead.
  operations: { list: 'open', get: 'open', update: 'approval', delete: 'approval' },
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Wire a messaging group to an agent group, and auto-create the matching channel destination ' +
        'so the agent can deliver to that chat as a target. ' +
        'Use --messaging-group-id <id> --agent-group-id <id> ' +
        '[--engage-mode mention|mention-sticky|pattern] [--engage-pattern <regex>] ' +
        '[--sender-scope all|known] [--ignored-message-policy drop|accumulate] ' +
        '[--session-mode shared|per-thread|agent-shared].',
      handler: async (args) => {
        const messagingGroupId = args.messaging_group_id as string | undefined;
        if (!messagingGroupId) throw new Error('--messaging-group-id is required');
        const agentGroupId = args.agent_group_id as string | undefined;
        if (!agentGroupId) throw new Error('--agent-group-id is required');

        // Replicate generic-create enum validation + DEFAULTS for the
        // remaining columns declared in this resource.
        const enums: Record<string, string[]> = {
          engage_mode: ['pattern', 'mention', 'mention-sticky'],
          sender_scope: ['all', 'known'],
          ignored_message_policy: ['drop', 'accumulate'],
          session_mode: ['shared', 'per-thread', 'agent-shared'],
        };
        function pick(name: keyof typeof enums, def: string): string {
          const v = args[name];
          if (v === undefined) return def;
          if (!enums[name].includes(String(v))) {
            throw new Error(`${name} must be one of: ${enums[name].join(', ')}`);
          }
          return String(v);
        }

        const mga: MessagingGroupAgent = {
          id: randomUUID(),
          messaging_group_id: messagingGroupId,
          agent_group_id: agentGroupId,
          engage_mode: pick('engage_mode', 'mention') as MessagingGroupAgent['engage_mode'],
          engage_pattern: args.engage_pattern !== undefined ? (args.engage_pattern as string) : null,
          sender_scope: pick('sender_scope', 'all') as MessagingGroupAgent['sender_scope'],
          ignored_message_policy: pick('ignored_message_policy', 'drop') as MessagingGroupAgent['ignored_message_policy'],
          session_mode: pick('session_mode', 'shared') as MessagingGroupAgent['session_mode'],
          priority: 0,
          created_at: new Date().toISOString(),
        };

        createMessagingGroupAgent(mga);
        return mga;
      },
    },
  },
});
