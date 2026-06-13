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
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { ensureContainerNetwork, initSnapshot } from './modules/container-bootstrap/index.js';
import { startHostRpcServer } from './modules/host-rpc/index.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { initiateShutdown } from './shutdown.js';
import { log } from './log.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

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

// Top-level host commands. Side-effect registration.
import './commands/stop.js'; // /stop (B1a)
import './cli/delivery-action.js';
import { startCliServer } from './cli/socket-server.js';

// Native-path credential providers (this branch runs the MITM proxy as the
// credential path). Registered explicitly at boot (not via the modules barrel)
// so unit tests don't arm the spawn-time validator unexpectedly.
import { registerClaudeCredentialProvider } from './providers/claude-credential.js';
import { registerGithubCredentialProvider } from './providers/github-credential.js';
import { registerOneCliBroker } from './providers/onecli-broker.js';
import { registerOneCliCredentialProvider } from './providers/onecli-credential.js';
import {
  CredentialProxy,
  setProxyInstance,
  initTokenEngine,
  initOAuthModule,
  oauthInteractive,
  dockerExecDeliver,
} from './modules/mitm-proxy/index.js';
import { getOrCreateResolverForAgentGroup } from './modules/credentials/index.js';
import { CREDENTIAL_PROXY_PORT } from './config.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { initChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';

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

  // 1c. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  ensureContainerNetwork();
  // Snapshot the container/ tree so in-flight containers don't see mid-run
  // host edits. Must precede router/sweep/delivery — they can wake containers.
  initSnapshot();
  cleanupOrphans();

  // Native credential proxy. Order matters: init the token engine, register the
  // Claude provider (its substitution facet reads the engine), then start the
  // proxy (whose rebuildIndex picks up the registered provider's swap rules),
  // publish the instance (the lifecycle observer then routes every container's
  // egress through it), and init the OAuth module for the discovery providers.
  initTokenEngine((scope) => getOrCreateResolverForAgentGroup(scope));
  registerClaudeCredentialProvider();
  registerGithubCredentialProvider();
  // C3 OneCLI-as-broker: the agent-identifier credential (grantable) + the
  // broker (registered only when OneCLI is configured; per-container network
  // work stays demand-gated to routed containers). See specs/onecli-broker.md.
  registerOneCliCredentialProvider();
  registerOneCliBroker();
  const credentialProxy = new CredentialProxy();
  // Bind all interfaces, not just loopback: containers reach the proxy via
  // host.docker.internal (the host-gateway IP), so a 127.0.0.1-only bind is
  // refused from inside a container.
  await credentialProxy.start({ port: CREDENTIAL_PROXY_PORT, host: '0.0.0.0' });
  setProxyInstance(credentialProxy);
  initOAuthModule({
    proxy: credentialProxy,
    oauthEvents: oauthInteractive,
    deliverCallback: dockerExecDeliver,
  });
  log.info('Credential proxy live', { port: credentialProxy.getBoundPort() });

  // 2b. Host-RPC server — containers reach it over the bridge network.
  // Started after the network exists so the bind is meaningful.
  await startHostRpcServer();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
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

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');
}

// SIGTERM (service stop) → graceful drain up to the budget; SIGINT (Ctrl-C) →
// immediate. A second signal mid-drain escalates to immediate (handled inside
// initiateShutdown). See src/shutdown.ts.
process.on('SIGTERM', () => void initiateShutdown(SHUTDOWN_DRAIN_TIMEOUT_MS, 'SIGTERM'));
process.on('SIGINT', () => void initiateShutdown(0, 'SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
