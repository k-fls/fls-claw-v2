import json, os
d = '/home/nanoclaw/nanoclaw2/data/v2-sessions/f6cc450d-a1dd-4e7b-ae18-6653e5e9e249/.claude-shared'
os.makedirs(d, exist_ok=True)
p = os.path.join(d, 'settings.json')
# Mirror DEFAULT_SETTINGS_JSON (group-init writes it only when ABSENT, and
# ensurePreCompactHook patches an existing file), plus our PreToolUse hook.
s = {
    "env": {
        "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
        "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0",
    },
    "hooks": {
        "PreCompact": [{"hooks": [{"type": "command", "command": "bun /app/src/compact-instructions.ts"}]}],
        "PreToolUse": [
            {"matcher": "Bash", "hooks": [{"type": "command", "command": "bash /workspace/agent/bin/sweep-no-tests.sh"}]},
            {"matcher": "Read", "hooks": [{"type": "command", "command": "bash /workspace/agent/bin/sweep-read-budget.sh"}]},
        ],
    },
}
json.dump(s, open(p, 'w'), indent=2)
open(p, 'a').write('\n')
os.chmod(p, 0o644)
print('wrote', p)
print('PreToolUse:', json.dumps(json.load(open(p))['hooks']['PreToolUse']))
