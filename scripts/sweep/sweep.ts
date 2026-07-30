/**
 * scripts/sweep/sweep.ts — the inventory validator CLI.
 *
 * Usage:
 *   pnpm exec tsx scripts/sweep/sweep.ts validate-registry [--repo <path>] [--inventory <dir>] [--out <file>]
 *
 * ONE subcommand:
 *   validate-registry  6-rule inventory validator vs --inventory (exit 1 on ALERTs)
 *
 * Flags:
 *   --repo <path>       repo to validate against  (default: cwd)
 *   --inventory <dir>   inventory to validate     (default: latest bootstrap snapshot)
 *   --out <file>        write the JSON result to a file instead of stdout
 *
 * This is all that remains of the M0 sweep pipeline
 * (`fetch|ff-main|scan|stop-points|merge|verify|record|status|route|replay|seed-rerere`,
 * removed 2026-07-30 — nothing on the agent's doctrined surface reached it, and the
 * propagation driver does its own merging/verifying/publishing). `validate-registry`
 * survives because it IS reached: it is step 3 of the `fork-registry-generate` skill,
 * which doctrine tells the maintainer to run whenever an inventory entry is added or
 * regenerated. Read-only — it never mutates anything.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { defaultInventoryDir } from './config.js';
import { loadFeatures } from './registry.js';
import { validateRegistry } from './validate.js';

const USAGE =
  'Usage: pnpm exec tsx scripts/sweep/sweep.ts validate-registry [--repo <path>] [--inventory <dir>] [--out <file>]';

interface Cli {
  cmd: string;
  repo: string;
  inventory: string | null;
  out?: string;
}

function parseCli(argv: string[]): Cli {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.error(USAGE);
    process.exit(2);
  }
  const cli: Cli = { cmd, repo: process.cwd(), inventory: null };
  let inventory: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const need = (): string => {
      const v = rest[++i];
      if (v === undefined) {
        console.error(`Missing value for ${flag}\n${USAGE}`);
        process.exit(2);
      }
      return v;
    };
    switch (flag) {
      case '--repo':
        cli.repo = need();
        break;
      case '--inventory':
        inventory = need();
        break;
      case '--out':
        cli.out = need();
        break;
      default:
        console.error(`Unknown flag ${flag}\n${USAGE}`);
        process.exit(2);
    }
  }
  cli.inventory = inventory !== undefined ? resolve(inventory) : defaultInventoryDir();
  return cli;
}

async function cmdValidateRegistry(cli: Cli): Promise<number> {
  const { features, warnings } = loadFeatures(cli.inventory);
  for (const w of warnings) console.error(`LOAD WARN: ${w}`);
  const result = await validateRegistry(cli.repo, features);
  const json = JSON.stringify(result, null, 2);
  if (cli.out) {
    writeFileSync(cli.out, json + '\n');
    console.log(`wrote ${cli.out}`);
  } else {
    console.log(json);
  }
  return result.ok ? 0 : 1;
}

const cli = parseCli(process.argv.slice(2));
if (cli.cmd !== 'validate-registry') {
  console.error(`Unknown subcommand '${cli.cmd}'\n${USAGE}`);
  process.exit(2);
}
cmdValidateRegistry(cli).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
