# GitHub Actions Workflows

This directory contains GitHub Actions workflows for CI/CD automation.

## Workflows

### CI (`ci.yml`)
Runs on every push and pull request to main/master/develop branches:
- Builds the project on Node.js versions 18.x, 20.x, and 22.x
- Runs ESLint to check code quality
- Compiles TypeScript
- Verifies build output

### Lint (`lint.yml`)
Runs on every push and pull request:
- Runs ESLint to check code quality
- Verifies TypeScript compilation

### Release (`release.yml`)
Runs when a GitHub release is created:
- Builds and lints the project
- Verifies package.json version matches the release tag
- Publishes to npm (requires NPM_TOKEN secret)

**Note**: To publish to npm, you need to:
1. Create an npm access token at https://www.npmjs.com/settings/YOUR_USERNAME/tokens
2. Add it as a secret named `NPM_TOKEN` in your GitHub repository settings

### CodeQL Analysis (`codeql.yml`)
Runs security analysis:
- Scans code for security vulnerabilities
- Runs on push, pull requests, and weekly schedule

## Setup

1. **NPM Token** (for publishing):
   - Go to https://www.npmjs.com/settings/YOUR_USERNAME/tokens
   - Create a new "Automation" token
   - Add it as a secret named `NPM_TOKEN` in GitHub repository settings:
     - Settings → Secrets and variables → Actions → New repository secret

2. **Branch Names**: 
   - Update workflow files if your default branch is not `main`, `master`, or `develop`

## Usage

### Creating a Release

1. Update `version` in `package.json`
2. Commit and push the changes
3. Create a new GitHub release with tag matching the version (e.g., `v0.0.1`)
4. The release workflow will automatically publish to npm

### Manual Release

You can also trigger the release workflow manually from the Actions tab, but you'll need to create the GitHub release separately.

