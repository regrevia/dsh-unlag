#!/bin/sh
# Publish the current version, then ask the registry for it. A publish that printed a version but
# never landed is the failure this script exists to catch: the tarball can exist before the
# package document lists the version, and `latest` only follows once it does.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
token=$(security find-generic-password -s npm-envoy-dsh -w)
config=$(mktemp)
trap 'rm -f "$config"' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$token" > "$config"
chmod 600 "$config"
if ! npm publish --userconfig "$config" --access public > /tmp/dsh-unlag-publish.log 2>&1; then
  grep -q 'previously published' /tmp/dsh-unlag-publish.log || { cat /tmp/dsh-unlag-publish.log >&2; exit 1; }
  echo "$version is already on the registry; checking that the package document lists it"
fi
attempt=0
while [ "$attempt" -lt 24 ]; do
  listed=$(curl -fsS "https://registry.npmjs.org/dsh-unlag" 2>/dev/null |
    node -e "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>{const d=JSON.parse(s);process.stdout.write(Object.hasOwn(d.versions,process.argv[1])?'yes':'no')})" "$version" || echo no)
  if [ "$listed" = yes ]; then
    echo "registry lists $version"
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done
echo "registry never listed $version" >&2
exit 1
