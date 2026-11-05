#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
package_dir=${PI_CLAUDE_CODE_PACKAGE:-"$HOME/.pi-pocket/vendor/pi-claude-code/node_modules/@earendil-works/pi-claude-code"}
source_file="$package_dir/src/claude-cli.ts"
test_file="$package_dir/tests/cache-control.test.ts"

if [[ ! -f "$package_dir/package.json" || ! -f "$source_file" ]]; then
    printf 'Claude Code provider package not found at %s\n' "$package_dir" >&2
    exit 1
fi

version=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$package_dir/package.json")
if [[ "$version" != "0.1.0" ]]; then
    printf 'Expected pi-claude-code 0.1.0, found %s; review the patch before applying it.\n' "$version" >&2
    exit 1
fi

if grep -q 'function trimCacheControlBlocks' "$source_file"; then
    if [[ -f "$test_file" ]]; then
        printf 'Claude Code cache patch is already applied.\n'
        exit 0
    fi
    printf 'The Claude Code cache patch is incomplete; restore package 0.1.0 before applying it.\n' >&2
    exit 1
fi

patch --batch --forward -p1 -d "$package_dir" < "$script_dir/pi-claude-code-cache-control.patch"
printf 'Applied the Claude Code cache patch to %s\n' "$package_dir"
