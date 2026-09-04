/**
 * Delete the scratch CLI agent created during setup's ping-pong test.
 *
 * Dynamically finds and removes all rows referencing the agent group
 * (any table with an agent_group_id column), deletes the agent group
 * itself, and removes the groups/<folder>/ directory. Leaves the CLI
 * messaging group intact so it can be reused for a new agent.
 *
 * Usage:
 *   pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>
 */
import fs from 'fs';
import path from 'path';

import { CENTRAL_DB_PATH, DATA_DIR } from '../src/config.js';
import { getAgentGroupByFolder, deleteAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

interface Args {
  folder: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let folder = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--folder' && argv[i + 1]) folder = argv[++i];
  }
  if (!folder) {
    console.error('usage: pnpm exec tsx scripts/delete-cli-agent.ts --folder <folder-name>');
    process.exit(1);
  }
  return { folder };
}

const args = parseArgs();

const db = await initDb(CENTRAL_DB_PATH);
await runMigrations(db);

const ag = await getAgentGroupByFolder(args.folder);
if (!ag) {
  console.log(`No agent group with folder "${args.folder}" — nothing to delete.`);
  process.exit(0);
}

await db.transaction(async () => {
  const tables = await db.all<{ name: string }>(
    `SELECT DISTINCT m.name FROM sqlite_master m
     JOIN pragma_table_info(m.name) p ON p.name = 'agent_group_id'
     WHERE m.type = 'table' AND m.name != 'agent_groups'`,
  );
  for (const { name } of tables) {
    const quotedName = `"${name.replaceAll('"', '""')}"`;
    await db.run(`DELETE FROM ${quotedName} WHERE agent_group_id = ?`, ag.id);
  }
  await deleteAgentGroup(ag.id);
});

// Remove the groups/<folder>/ directory.
const groupDir = path.join(process.cwd(), 'groups', args.folder);
if (fs.existsSync(groupDir)) {
  fs.rmSync(groupDir, { recursive: true });
}

// Remove session data on disk.
const sessionsDir = path.join(DATA_DIR, 'v2-sessions', ag.id);
if (fs.existsSync(sessionsDir)) {
  fs.rmSync(sessionsDir, { recursive: true });
}

console.log(`Deleted agent group ${ag.id} (${args.folder}).`);
