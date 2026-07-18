#!/bin/bash
# profile.sh <branch> <from-height> <to-height>  -> writes $SP/profiles/<slug>.txt
SP=/tmp/claude-1000/-home-user-workspace-fls-fls-claw-v2-server/ac444400-eb8a-49ee-9872-f029867bcbb8/scratchpad/mined-cases
cd /home/user/workspace/fls/fls-claw-v2-clean
b="$1"; from="$2"; to="$3"
slug=$(echo "$b" | tr '/' '-')
outf="$SP/profiles/$slug.txt"
: > "$outf"
for h in $(seq $from $to); do
  sha=$(sed -n "${h}p" $SP/chain.txt)
  out=$(git merge-tree --write-tree --name-only "$b" "$sha" 2>&1); code=$?
  tree=$(echo "$out" | head -1)
  if [ $code -eq 0 ]; then
    echo "$h $sha CLEAN tree=$tree" >> "$outf"
  else
    files=$(echo "$out" | awk 'NR>1 && NF==0 {exit} NR>1 {printf "%s%s", sep, $0; sep=","}')
    echo "$h $sha CONFLICT [$files] tree=$tree" >> "$outf"
  fi
done
echo "DONE $b" >> "$outf"
