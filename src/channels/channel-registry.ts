/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, OutboundFile } from './adapter.js';
import type { ChannelDeliveryAdapter } from '../delivery.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/**
 * How often a channel that failed to start is retried.
 *
 * SETUP_RETRY_DELAYS_MS covers a hiccup inside one start attempt (~17s total).
 * This covers the outage that outlives it. `activeAdapters` is otherwise
 * written only by initChannelAdapters, whose sole production caller runs once
 * at boot (src/index.ts) before the delivery polls start — so without this pass
 * an adapter that threw at boot stays dead for the life of the process, and the
 * missing-adapter grace window in delivery.ts can only ever be redeemed by an
 * operator restarting the host.
 *
 * The real incident this addresses: rapid host restarts churned Slack Socket
 * Mode connections, `apps.connections.open` returned a transient `invalid_auth`,
 * `initialize` threw, and the adapter never registered — while the tokens
 * themselves were valid the whole time.
 *
 * A minute is well inside delivery.ts's MISSING_ADAPTER_GRACE_MS, so a channel
 * that recovers gets several attempts before any held row is failed, and slow
 * enough that a channel which is down for real costs one factory call per
 * minute rather than one per delivery poll.
 */
export const ADAPTER_RETRY_INTERVAL_MS = 60_000;

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

/**
 * Channels whose start attempt threw, held for the periodic retry pass along
 * with the setup callback so a retry repeats exactly what boot did. Entries
 * leave on the first attempt that does not throw — including a factory that
 * returns null, which is a deliberate "no credentials, skip" answer rather than
 * a transient failure and must not be retried forever.
 */
const pendingRetry = new Map<string, ChannelRegistration>();
let retrySetupFn: ((adapter: ChannelAdapter) => ChannelSetup) | undefined;
let retryTimer: ReturnType<typeof setInterval> | undefined;
let retryInFlight = false;

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by its EXACT registry key (instance name; default
 *  instances are keyed by channelType itself). No channelType fallback —
 *  callers that address a specific instance (outbound delivery, typing)
 *  must never be rerouted through a sibling instance: that would send
 *  through the wrong bot identity with the wrong token. A missing key
 *  means the owning adapter is offline; callers apply their normal
 *  offline-adapter handling. */
export function getChannelAdapterExact(key: string): ChannelAdapter | undefined {
  return activeAdapters.get(key);
}

/** Get a live adapter by instance name, falling back to any adapter of the
 *  given channel type. The fallback exists ONLY for channelType-only callers
 *  (user-id prefix resolution and cold DMs in user-dm.ts, approval delivery
 *  in channel-approval.ts, the router's thread-policy probe when an event
 *  carries no instance) — they must still resolve when every instance of a
 *  platform is named. First registered wins (Map insertion order,
 *  deterministic). Default instances are keyed by channelType itself, so
 *  single-instance installs always hit the exact-key path. Instance-addressed
 *  dispatch (delivery, typing) must use getChannelAdapterExact instead. */
export function getChannelAdapter(key: string): ChannelAdapter | undefined {
  const exact = activeAdapters.get(key);
  if (exact) return exact;
  for (const [registryKey, adapter] of activeAdapters) {
    if (adapter.channelType === key) {
      log.warn('Channel adapter fallback: requested key resolved through a differently-keyed instance', {
        requested: key,
        resolvedKey: registryKey,
      });
      return adapter;
    }
  }
  return undefined;
}

/** Thrown by the delivery bridge when the exact adapter for an outbound
 *  message is not registered (credentials missing so the factory returned
 *  null, setup failed, or a named instance is offline). Deliberately a throw
 *  rather than an `undefined` return: `undefined` is also what a successful
 *  adapter with no platform message id resolves to, and a normal return makes
 *  `drainSession` mark the row delivered even though nothing was sent.
 *  Throwing routes the message into the delivery retry path instead. */
export class MissingChannelAdapterError extends Error {
  constructor(
    readonly channelType: string,
    readonly instance?: string,
  ) {
    super(
      `No adapter registered for '${instance ?? channelType}' — message enters the delivery retry path. ` +
        `Check the startup log for why this channel's adapter did not start.`,
    );
    this.name = 'MissingChannelAdapterError';
  }
}

/**
 * Build the host's outbound delivery bridge: dispatches delivery-poll and
 * typing traffic into the adapter registry. Resolution is EXACT-key only —
 * `instance ?? channelType`. For default-instance messaging_groups rows the
 * stored instance IS the channelType, which matches default-registered
 * adapters, so single-instance behavior is unchanged. A named instance whose
 * adapter is offline gets the normal offline-adapter handling
 * (MissingChannelAdapterError → the delivery retry path) — never a
 * cross-identity send through a sibling bot of the same platform.
 */
export function createChannelDeliveryAdapter(): ChannelDeliveryAdapter {
  return {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: OutboundFile[],
      instance?: string,
    ): Promise<string | undefined> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      if (!adapter) {
        throw new MissingChannelAdapterError(channelType, instance);
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(
      channelType: string,
      platformId: string,
      threadId: string | null,
      instance?: string,
    ): Promise<void> {
      const adapter = getChannelAdapterExact(instance ?? channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate, set up and register ONE channel adapter.
 *
 * Returns true when the adapter is live, false when it was deliberately
 * skipped (factory returned null — no credentials). Throws when the attempt
 * failed for a reason that may not still hold a minute from now; the caller
 * decides whether that lands in the retry set.
 */
async function startAdapter(
  name: string,
  registration: ChannelRegistration,
  setupFn: (adapter: ChannelAdapter) => ChannelSetup,
): Promise<boolean> {
  const adapter = await registration.factory();
  if (!adapter) {
    log.warn('Channel credentials missing, skipping', { channel: name });
    return false;
  }

  const setup = setupFn(adapter);
  // Transient network failures during adapter init (e.g. Telegram deleteWebhook
  // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
  // dead until manual restart. Retry only on NetworkError so misconfigs (bad
  // tokens, etc.) still fail fast.
  let attempt = 0;
  while (true) {
    try {
      await adapter.setup(setup);
      break;
    } catch (err) {
      if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
        const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
        log.warn('Channel adapter setup failed with network error, retrying', {
          channel: name,
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
  // Adapters key by instance (default instance = channelType), so N
  // instances of one platform coexist. Duplicate keys warn instead of
  // throwing — boot stays resilient, matching the historical silent
  // last-write-wins, but now visibly.
  const key = adapter.instance ?? adapter.channelType;
  if (activeAdapters.has(key)) {
    log.warn('Duplicate adapter instance key — overwriting previous adapter', { key, channel: name });
  }
  activeAdapters.set(key, adapter);
  log.info('Channel adapter started', { channel: name, type: adapter.channelType, instance: key });
  return true;
}

/**
 * Re-attempt every channel still in the retry set. Failures stay in the set and
 * drop to debug after the boot-time error, so a channel that is down for hours
 * does not fill the log with one error per minute — the ERROR from boot is the
 * operator's signal, and recovery gets its own INFO.
 */
async function retryFailedAdapters(): Promise<void> {
  const setupFn = retrySetupFn;
  if (!setupFn || retryInFlight) return;
  // A single pass can take ~17s per channel via SETUP_RETRY_DELAYS_MS, so it can
  // outlast the interval; overlapping passes would race two factories for the
  // same activeAdapters key.
  retryInFlight = true;
  try {
    for (const [name, registration] of [...pendingRetry]) {
      try {
        const started = await startAdapter(name, registration, setupFn);
        // Leaves the set either way: a null factory is a config answer, not a
        // transient failure, and retrying it every minute would never converge.
        pendingRetry.delete(name);
        if (started) log.info('Channel adapter recovered on retry', { channel: name });
      } catch (err) {
        log.debug('Channel adapter retry failed, will try again', { channel: name, err });
      }
    }
  } finally {
    retryInFlight = false;
  }
  if (pendingRetry.size === 0) stopAdapterRetry();
}

/** Arm the retry pass. No-op when nothing is pending or it is already armed. */
function scheduleAdapterRetry(): void {
  if (retryTimer || pendingRetry.size === 0) return;
  retryTimer = setInterval(() => {
    void retryFailedAdapters();
  }, ADAPTER_RETRY_INTERVAL_MS);
  // A channel that never comes back must not keep the host — or a test run —
  // from exiting.
  retryTimer.unref?.();
}

function stopAdapterRetry(): void {
  if (!retryTimer) return;
  clearInterval(retryTimer);
  retryTimer = undefined;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 *
 * Channels that throw are kept and retried every ADAPTER_RETRY_INTERVAL_MS, so
 * a transient boot failure no longer costs the channel the whole process
 * lifetime. Delivery reads the same activeAdapters map, so a recovered adapter
 * is picked up by the next delivery poll with no further wiring.
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  retrySetupFn = setupFn;
  for (const [name, registration] of registry) {
    try {
      await startAdapter(name, registration, setupFn);
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
      pendingRetry.set(name, registration);
    }
  }
  scheduleAdapterRetry();
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  stopAdapterRetry();
  pendingRetry.clear();
  retrySetupFn = undefined;
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
