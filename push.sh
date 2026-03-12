#!/bin/bash

# Script to automatically push changes to GitHub
# Usage: ./push.sh "commit message"

COMMIT_MSG=$1
if [ -z "$COMMIT_MSG" ]; then
    COMMIT_MSG="chore: update application"
fi

echo "🚀 Starting push to GitHub..."

# Add all changes
git add .

# Commit
git commit -m "$COMMIT_MSG"

# Push to origin main
git push origin main

echo "✅ Done! Changes pushed to GitHub."
