/**
 * Provider extensions (see docs/fls/provider-model.md).
 *
 * The credential provider (`./registry.ts`) is the provider entity. A
 * provider's capabilities beyond its credential namespace — driving the
 * agent runtime, OAuth/refresh production, reauth prompting, classifying
 * MITM responses or container-agent errors, per-container state — attach as
 * **typed extensions**, retrieved via `CredentialProvider.getExtension(type)`.
 *
 * Pattern: define a typed key with `defineExtension<T>(id)`, declare values
 * with `new ExtensionBag().set(KEY, value)`, expose `bag.get` as the
 * provider's `getExtension`. Extension value types + keys are catalogued here;
 * each body lands with the module that consumes it.
 *
 * The MITM substitution capability is NOT an extension — it stays the
 * `SubstitutingProvider.substitutes` property (existing rails).
 */
import type { InteractionOrigin } from '../../../host-interactions.js';
import type { VolumeMount, ProviderContainerContribution } from '../../../providers/provider-container-registry.js';
import type { CredentialScope, GroupScope } from '../types.js';

// ── Extension mechanism ─────────────────────────────────────────────────────

/** A typed extension key. The phantom `T` ties the key to its value type. */
export interface ExtensionType<T> {
  readonly id: string;
  /** Phantom — never read at runtime; carries `T` for inference. */
  readonly __t?: (x: T) => void;
}

export function defineExtension<T>(id: string): ExtensionType<T> {
  return { id };
}

/**
 * Holds a provider's extensions by key. Declare with `set`, then expose
 * `bag.get` as the provider's `getExtension`:
 *
 *   const ext = new ExtensionBag().set(AGENT_RUNTIME, runtime).set(REAUTH, driver);
 *   const provider = { id, buildManifest, …, getExtension: ext.get };
 */
export class ExtensionBag {
  private readonly map = new Map<string, unknown>();

  set<T>(type: ExtensionType<T>, value: T): this {
    this.map.set(type.id, value);
    return this;
  }

  /** Arrow so it can be passed directly as `getExtension` (bound). */
  readonly get = <T>(type: ExtensionType<T>): T | undefined => this.map.get(type.id) as T | undefined;

  has(type: ExtensionType<unknown>): boolean {
    return this.map.has(type.id);
  }
}

// ── Agent runtime ──────────────────────────────────────────────────────

export interface AgentRuntimeExt {
  containerContribution(ctx: {
    agentGroupId: string;
    /** The group's runtime scope — keys substitute minting in the token engine. */
    groupScope: GroupScope;
    sessionDir: string;
    hostEnv: NodeJS.ProcessEnv;
    runtimeConfig: unknown;
    /**
     * Selected CLI version from the provider identity's `:version` suffix
     * (`2.1.154` | `latest`), or undefined for the default. The runtime maps it
     * to a host-installed CLI mount via its RUNTIME_UPDATER (F2).
     */
    cliVersion?: string;
  }): { env?: Record<string, string>; mounts?: VolumeMount[] };
  requiredCredentialProviders(runtimeConfig: unknown): Array<{ id: string; required: boolean }>;
  parseRuntimeConfig(raw: unknown): unknown;
  /**
   * Hostnames whose traffic this runtime wants excluded from an untargeted
   * `/tap all` by default — i.e. the endpoint(s) the agent's own model calls
   * go to. Reported programmatically because the endpoint is *configurable*:
   * a Claude runtime pointed at Ollama (`ANTHROPIC_BASE_URL=http://host:11434`)
   * sends its traffic there, not to api.anthropic.com, and that host matches
   * no credential-provider rule — so only the provider, reading its own
   * per-group config, can name it. Return bare hostnames (no scheme/port);
   * the tap excludes exact host matches. Omit / return empty to exclude
   * nothing by default. An explicit `/tap all exclude=…` (provider-id based)
   * is a separate, independent override.
   */
  defaultTapExcludeHosts?(cfg: RuntimeTapConfig): Iterable<string>;
}

/** Per-group config a runtime reads to derive its `defaultTapExcludeHosts`. */
export interface RuntimeTapConfig {
  /** The base-v2 opaque per-runtime config dict (`ContainerConfig.runtimeConfig`), if any. */
  runtimeConfig?: unknown;
  /** Materialized container env — present once a skill (e.g. add-ollama-provider) wires `env`. */
  env?: Record<string, string>;
  /** Configured model name, if any. */
  model?: string;
}
export const AGENT_RUNTIME = defineExtension<AgentRuntimeExt>('agentRuntime');

/**
 * Input to provider-contribution resolution (`resolveProviderContribution`,
 * container-runner). The resolver builds this once — including resolving the
 * provider's AGENT_RUNTIME extension — then capability helpers (agent-runtime
 * contribution → mitm-proxy, cli-version → runtime-updater) read it and set
 * their own field on the result. Carrying everything here keeps each helper a
 * pure `(input) => value`, so they compose without co-editing the resolver.
 */
export interface ContributionInput {
  provider: string;
  /** Raw `session.agent_provider` (the `provider[:version]` identity), for updater to parse. */
  agentProvider: string | null | undefined;
  /** Per-group configured CLI version (`ContainerConfig.providerVersion`), for updater. */
  providerVersion: string | undefined;
  agentGroupId: string;
  groupScope: GroupScope;
  sessionDir: string;
  hostEnv: NodeJS.ProcessEnv;
  /** Opaque per-runtime config dict (`ContainerConfig.runtimeConfig`). */
  runtimeConfig: unknown;
  /** The provider's agent-runtime extension, resolved by the resolver (or undefined). */
  runtime: AgentRuntimeExt | undefined;
}

/** Result of provider-contribution resolution. */
export interface ProviderResult {
  provider: string;
  contribution: ProviderContainerContribution;
  /** Concrete fetched CLI version this spawn mounts, or null = image-baked. */
  cliVersion: string | null;
}

// ── Per-container state ──────────────────────────────────────────

export interface ContainerContext {
  agentGroupId: string;
  scope: GroupScope;
  containerName: string;
}
export interface ContainerExitContext extends ContainerContext {
  exitCode: number | null;
  reason: 'normal' | 'killed' | 'spawn-error';
}
/**
 * One opaque `T` per (provider, container). Declare only when extensions of
 * the same provider must observe each other's runtime context within one
 * container (Claude's MITM-observed error informing the container-side
 * classifier). Most providers omit it.
 */
export interface ContainerStateDecl<T> {
  init(ctx: ContainerContext): T;
  teardown?(state: T, ctx: ContainerExitContext): void;
}
export const CONTAINER_STATE = defineExtension<ContainerStateDecl<unknown>>('containerState');

// ── Feedback ────────────────────────────────────────────────

export interface ContainerErrorEvent {
  message: string;
  retryable: boolean;
  classification?: string;
}
export type FeedbackAction = 'reauth' | 'mark-stale' | 'surface' | 'ignore';

/** Classifies container-agent error events (from `ProviderEvent.error`). */
export interface ContainerFeedbackExt<T = unknown> {
  onContainerError(event: ContainerErrorEvent, state: T | undefined, ctx: ContainerContext): FeedbackAction;
}
export const CONTAINER_FEEDBACK = defineExtension<ContainerFeedbackExt>('feedback.container');

/** Classifies upstream MITM responses (e.g. 401 → auth). */
export interface MitmFeedbackExt<T = unknown> {
  classify(
    responseBody: string,
    statusCode: number,
    state: T | undefined,
  ): 'auth' | 'rate-limit' | 'network' | 'ok' | null;
}
export const MITM_FEEDBACK = defineExtension<MitmFeedbackExt>('feedback.mitm');

// ── Producer / reauth / ux ────────────────────────────────────────

/** OAuth flow / device-code / refresh production. Body not yet implemented. */
export interface ProducerExt {
  readonly kind: string;
}
export const PRODUCER = defineExtension<ProducerExt>('producer');

/** Context handed to a provider's reauth driver when a credential goes stale. */
export interface ReauthContext {
  /** Interaction origin to prompt the user on. */
  origin: InteractionOrigin;
  /**
   * Scope to store the replacement credential under. Write/store is
   * own-scope only, hence `CredentialScope`.
   */
  credentialScope: CredentialScope;
  /** The container classifier's tag that triggered this, e.g. 'auth-invalid'. */
  classification: string;
  /** Sanitized, length-capped human-readable reason (the container error). */
  reason: string;
}

/**
 * Interactive re-authentication. Resolves `true` iff a replacement
 * credential was stored; `false` on cancel / timeout / decline. The provider
 * owns the whole UX behind `reauth()`. The mid-session dispatcher that drives
 * it lands with its consumer module (downstream); only the contract lives here.
 */
export interface ReauthExt {
  reauth(ctx: ReauthContext): Promise<boolean>;
}
export const REAUTH = defineExtension<ReauthExt>('reauth');

/** `/auth` status custom rendering. Body not yet implemented. */
export interface UxExt {
  readonly id: string;
}
export const UX = defineExtension<UxExt>('ux');

// ── Runtime CLI updater ─────────────────────────────────────────────────

/**
 * A runtime's ability to install its agent-CLI binary on the host so it can be
 * updated **without an image rebuild** (inventory F). The mechanism is only
 * this: install a version, and report the host directory it lives in. Each
 * version installs into its own immutable directory, so there is no in-place
 * swap (and no lock): a spawn only ever reads a fully-installed, never-mutated
 * dir. How that directory is exposed to a container (mount target, how the
 * runtime's CLI path is pointed at it) is the *provider's* concern — it's
 * runtime-specific — so the updater returns only the host path.
 *
 * Everything else — which version to run, periodic-refresh cadence, the
 * setting string — is *policy*, not a provider concern; it lives in the host
 * `runtime-updater` module's update manager, keyed per provider. Only providers
 * that support runtime updates declare this; the rest omit it and
 * `/agent-runtime` reports "not supported" for their groups.
 *
 * Generalizes the fork's claude-only `claude-updater`: in v2 the agent runtime
 * is a per-provider concern (claude → `@anthropic-ai/claude-code`,
 * opencode/codex → their own CLIs), so the install mechanism is a provider
 * capability rather than a global module.
 */
export interface RuntimeUpdaterExt {
  /** Human label for the CLI being managed (e.g. "Claude Code"). */
  readonly label: string;
  /** The package managed (e.g. "@anthropic-ai/claude-code"). For status output. */
  readonly packageName: string;
  /** Latest published version, or null on lookup failure. */
  latestVersion(): string | null;
  /** Versions currently installed on disk (unordered). */
  installedVersions(): string[];
  /**
   * Host directory of an already-installed `version`, or null if not installed.
   * Synchronous — used on the spawn path, which never installs (a group can
   * only select a version a global admin has already fetched).
   */
  installedDir(version: string): string | null;
  /**
   * Ensure `version` is installed (install it if absent) and return its host
   * directory. Privileged (a global admin's `/agent-runtime fetch`): runs
   * `npm install`.
   */
  fetch(version: string): Promise<string>;
  /** Remove an installed version's directory. No-op if not installed. */
  remove(version: string): void;
}
export const RUNTIME_UPDATER = defineExtension<RuntimeUpdaterExt>('runtimeUpdater');
