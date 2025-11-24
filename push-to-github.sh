#!/usr/bin/env bash
# LinkedIn Scraper - GitHub Push Script
# 
# Usage: After creating your GitHub repo, update the URL below and run:
# ./push-to-github.sh
# 
# On Windows PowerShell, run the commands manually or:
# bash push-to-github.sh

# Configuration - EDIT THIS WITH YOUR DETAILS
GITHUB_USERNAME="bodhisattwai"  # Your GitHub username
REPO_NAME="linkedin-jobs-scraper"
REPO_URL="https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"

echo "╔════════════════════════════════════════╗"
echo "║  LinkedIn Scraper - GitHub Push       ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Repository URL: $REPO_URL"
echo ""

# Navigate to project directory
cd "$(dirname "$0")" || exit

# Check if git is initialized
if [ ! -d ".git" ]; then
    echo "❌ Git not initialized. Run 'git init' first."
    exit 1
fi

echo "📤 Pushing to GitHub..."
echo ""

# Add remote
git remote add origin "$REPO_URL" 2>/dev/null || git remote set-url origin "$REPO_URL"

# Rename to main
git branch -M main

# Push
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Successfully pushed to GitHub!"
    echo ""
    echo "📖 Next steps:"
    echo "1. Verify: $REPO_URL"
    echo "2. Go to: https://console.apify.com"
    echo "3. Create actor from GitHub repository"
    echo "4. Paste URL: $REPO_URL"
else
    echo ""
    echo "❌ Push failed. Check your credentials and try again."
    exit 1
fi
