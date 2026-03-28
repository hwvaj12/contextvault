#!/bin/bash
# Hourly check for ContextVault project progress

cd ~/Desktop/Ventures/ContextVault

# Check last commit time
LAST_COMMIT=$(git log -1 --format="%ai" 2>/dev/null || echo "none")
LAST_MSG=$(git log -1 --format="%s" 2>/dev/null || echo "none")

# Check if API is running
API_STATUS=$(curl -s http://localhost:3000/health 2>/dev/null || echo "not running")

# Log status
echo "$(date): LAST_COMMIT=$LAST_COMMIT MSG='$LAST_MSG' API=$API_STATUS"

# Check for Claude Code processes
CLAUDE_RUNNING=$(ps aux | grep -i claude | grep -v grep | wc -l)

if [ "$CLAUDE_RUNNING" -eq 0 ]; then
    echo "WARNING: No Claude Code running. Project may be stuck."
fi
