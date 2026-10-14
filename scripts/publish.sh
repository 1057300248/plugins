#!/bin/sh
# Publishes every package whose version isn't on npm yet.
#   scripts/publish.sh [otp]     (by hand: the npm account's one-time password)
# GitHub Actions runs it with no password on each version bump pushed to
# main (.github/workflows/publish.yml, npm's trusted publishing).
# One password covers the lot: it is sent with each publish while it lasts.
# Trusted publishing can't make a package npm has never seen, and npm
# refuses (404) one whose Trusted Publisher isn't set. Actions publishes
# both with the NPM_TOKEN secret, which npm falls back to when OIDC fails.
# Without the secret Actions passes a new package by, publishes the rest,
# and fails at the end naming what it couldn't publish; by hand,
# `scripts/publish.sh <otp>` from an npm account of the magpie-community
# org publishes it.
set -e
cd "$(dirname "$0")/.."
# npm's own registry, whatever ~/.npmrc names (a mirror such as npmmirror
# takes no publish)
export npm_config_registry=https://registry.npmjs.org
# setup-node's .npmrc reads the token from NODE_AUTH_TOKEN
if [ -n "$NPM_TOKEN" ]; then
  export NODE_AUTH_TOKEN="$NPM_TOKEN"
fi
bun scripts/check.mjs
otp="$1"
for dir in packages/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  version=$(node -p "require('./${dir}package.json').version")
  if [ "$(npm view "$name@$version" version 2>/dev/null)" = "$version" ]; then
    echo "= $name@$version is on npm already"
    continue
  fi
  if [ -n "$GITHUB_ACTIONS" ] && [ -z "$otp$NPM_TOKEN" ] && ! npm view "$name" name >/dev/null 2>&1; then
    echo "::error::$name is not on npm yet: trusted publishing can't create it, and the repository has no NPM_TOKEN secret. Add one (README, Publishing) and re-run this workflow, or publish its first version by hand (scripts/publish.sh <otp>)."
    new="$new $name"
    continue
  fi
  if ! (cd "$dir" && npm publish --access public ${otp:+--otp="$otp"}); then
    if [ -n "$GITHUB_ACTIONS" ] && [ -n "$NPM_TOKEN" ]; then
      echo "::error::$name@$version wasn't published with OIDC or NPM_TOKEN: the token may have expired (npm's write tokens last 90 days at most) or lost access to @magpie-community. Replace the NPM_TOKEN secret (README, Publishing)."
    elif [ -n "$GITHUB_ACTIONS" ]; then
      echo "::error::$name@$version wasn't published: this workflow isn't its Trusted Publisher on npmjs.com, and the repository has no NPM_TOKEN secret (README, Publishing)."
    fi
    refused="$refused $name"
  fi
done
if [ -n "$new" ]; then
  echo "not published, new to npm:$new"
fi
if [ -n "$refused" ]; then
  echo "not published, refused by npm:$refused"
fi
if [ -n "$new$refused" ]; then
  exit 1
fi
