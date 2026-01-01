/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { DATA_DIR, SHUTDOWN_DRAIN_TIMEOUT_MS } from './config.js';
import { enforceStartupBackoff } from './circuit-breaker.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter } from './delivery.js';
import { startHostSweep } from './host-sweep.js';
import { startHostModules } from './host-lifecycle.js';
import { routeInbound } from './router.js';
import { initiateShutdown } from './shutdown.js';
import { log } from './log.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';

// Response registry lives in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler };
export type { ResponsePayload, ResponseHandler };

const hostAbortController = new AbortController();

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0.5 Upgrade tripwire — refuse to start if this install was updated
  // outside the sanctioned path (raw `git pull` instead of /update-nanoclaw).
  enforceUpgradeTripwire();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          // The one host-side stamping seam: adapters stay instance-blind,
          // the host stamps the receiving instance on every inbound event.
          instance: adapter.instance ?? adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters by EXACT
  // registry key (instance ?? channelType): a named instance with an
  // offline adapter is never rerouted through a sibling bot. See
  // createChannelDeliveryAdapter in channels/channel-registry.ts.
  setDeliveryAdapter(createChannelDeliveryAdapter());

  // 5. Start registered host modules. Imports only registered callbacks; the
  // actual work begins here, after DB + delivery are ready and before polls.
  await startHostModules({ db, signal: hostAbortController.signal });

  // 6. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 7. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 8. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');
}

// SIGTERM (service stop) → graceful drain up to the budget; SIGINT (Ctrl-C) →
// immediate. A second signal mid-drain escalates to immediate (handled inside
// initiateShutdown). See src/shutdown.ts.
process.on('SIGTERM', () => {
  hostAbortController.abort();
  void initiateShutdown(SHUTDOWN_DRAIN_TIMEOUT_MS, 'SIGTERM');
});
process.on('SIGINT', () => {
  hostAbortController.abort();
  void initiateShutdown(0, 'SIGINT');
});

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
