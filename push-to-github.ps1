# LinkedIn Scraper - GitHub Push Script (PowerShell)
#
# Usage: 
# 1. Edit the variables below with your GitHub username
# 2. Run this script: .\push-to-github.ps1
#
# On Windows 10/11, you may need to run:
# Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser

# ============= CONFIGURATION =============
$GITHUB_USERNAME = "bodhisattwai"  # Your GitHub username
$REPO_NAME = "linkedin-jobs-scraper"
$REPO_URL = "https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"
# =========================================

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   LinkedIn Scraper - GitHub Push       " -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Repository URL: $REPO_URL" -ForegroundColor Yellow
Write-Host ""

# Check if in correct directory
if (-Not (Test-Path ".\.git")) {
    Write-Host "[ERROR] Git not initialized. Run 'git init' first." -ForegroundColor Red
    exit 1
}

Write-Host "... Pushing to GitHub..." -ForegroundColor Green
Write-Host ""

try {
    # Add or update remote
    Write-Host "1. Adding/updating remote..." -ForegroundColor Cyan
    git remote add origin $REPO_URL 2>$null
    if ($LASTEXITCODE -ne 0) {
        git remote set-url origin $REPO_URL
    }

    # Rename branch to main
    Write-Host "2. Renaming branch to main..." -ForegroundColor Cyan
    git branch -M main

    # Push to GitHub
    Write-Host "3. Pushing code to GitHub..." -ForegroundColor Cyan
    git push -u origin main

    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "[SUCCESS] Successfully pushed to GitHub!" -ForegroundColor Green
        Write-Host ""
        Write-Host "Next steps:" -ForegroundColor Yellow
        Write-Host "1. Verify: $REPO_URL"
        Write-Host "2. Go to: https://console.apify.com"
        Write-Host "3. Create new actor - GitHub repository"
        Write-Host "4. Paste URL: $REPO_URL"
        Write-Host ""
    } else {
        Write-Host ""
        Write-Host "[ERROR] Push failed. Check your credentials and try again." -ForegroundColor Red
        exit 1
    }
} catch {
    Write-Host "[ERROR] Error: $_" -ForegroundColor Red
    exit 1
}
