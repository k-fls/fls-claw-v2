/**
 * Internal container-bootstrap observer: allocate a bridge-network IP at
 * spawn time, splice `networkArgs(ip)` into the docker args, and release
 * the IP on container exit (incl. spawn-error).
 *
 * Self-registers at module load via the barrel side-effect import. Was
 * previously hard-wired in `container-runner.spawnContainer`; the move
 * collapses the "allocate / build args / release on every exit path"
 * trio into a single observer with a cleanup callback.
 */
import { allocateContainerIP } from './ip-registry.js';
import { networkArgs } from './network.js';
import { registerContainerLifecycleObserver } from './registry.js';
import { asContainerScope } from './types.js';

registerContainerLifecycleObserver('container-ip', {
  onSpawnPre(ctx) {
    // Scope key is the agent-group **folder**, not its id: the credential /
    // substitute / MITM stack is folder-keyed throughout
    // (`getOrCreateResolverForAgentGroup(ownFolder)`, `credentialsDir/<folder>`,
    // substitutes minted under `asGroupScope(folder)`). The proxy resolves a
    // request's scope via `lookupContainerIP(sourceIP)` and feeds it straight
    // into `resolveSubstitute`, so this must be the folder or the swap can't
    // find the minted substitute.
    const allocated = allocateContainerIP(asContainerScope(ctx.agentGroup.folder), ctx.session.id);
    return {
      args: [...networkArgs(allocated.ip)],
      cleanup: () => allocated.release(),
    };
  },
});
