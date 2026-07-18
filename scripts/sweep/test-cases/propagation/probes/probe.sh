#!/bin/bash
# probe.sh <branch-or-sha> <head-sha> -> prints "EXIT <code>" then merge-tree output
cd /home/user/workspace/fls/fls-claw-v2-clean
out=$(git merge-tree --write-tree "$1" "$2" 2>&1)
code=$?
echo "EXIT $code"
echo "$out"
