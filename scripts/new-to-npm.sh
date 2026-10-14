#!/bin/sh
# Names any package here that has never been published to npm. Trusted
# publishing can't create a package; publish.yml does it with the NPM_TOKEN
# secret when the pull request is merged (README, Publishing). A pull
# request runs this so the reviewer knows a merge publishes a new name.
set -e
cd "$(dirname "$0")/.."
export npm_config_registry=https://registry.npmjs.org
for dir in packages/*/; do
  name=$(node -p "require('./${dir}package.json').name")
  if [ "$(npm view "$name" name 2>/dev/null)" != "$name" ]; then
    echo "::notice file=${dir}package.json::$name is not on npm yet. Merging publishes its first version with the NPM_TOKEN secret (README, Publishing)."
    new="$new $name"
  fi
done
if [ -n "$new" ]; then
  echo "new to npm:$new"
else
  echo "every package is on npm"
fi
