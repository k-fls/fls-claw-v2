/**
 * SSH subsystem — public API + self-registration.
 *
 * Importing this barrel registers the `ssh` and `pem-passwords` credential
 * providers and initializes the SSHManager + `/ssh` host-rpc handler.
 * Importing it also pulls in `./commands/ssh.js`, which self-registers the
 * `/ssh` and `/pem` host commands.
 */
import { initSSHSystem, registerSSHProviders } from './init.js';

// Self-register at module load. Order:
//   1. Providers (must precede first writeKeysFile / manifest pipeline use).
//   2. SSHManager + host-rpc handler.
//   3. Host commands.
registerSSHProviders();
initSSHSystem();

import './commands/ssh.js';

export { initSSHSystem, getSSHManager } from './init.js';
export { socketDir } from './manager.js';
export type { SSHManager } from './manager.js';
