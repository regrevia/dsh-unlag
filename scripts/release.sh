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
# The package document is behind a CDN cache: it kept listing the previous version for a minute
# after a publish that had already landed, while the version's own document answered at once. So
# the version document decides, and the cache-busted package document only reports the tag.
attempt=0
while [ "$attempt" -lt 24 ]; do
  stamp=$(date +%s)
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/dsh-unlag/$version?t=$stamp" || echo 000)
  if [ "$code" = 200 ]; then
    echo "registry serves $version"
    tag=$(curl -fsS "https://registry.npmjs.org/dsh-unlag?t=$stamp" 2>/dev/null |
      node -e "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>{try{process.stdout.write(JSON.parse(s)['dist-tags'].latest)}catch{process.stdout.write('?')}})" || echo '?')
    if [ "$tag" != "$version" ]; then
      echo "note: the latest tag still reads $tag; it follows on its own"
    fi
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 5
done
echo "registry never served $version" >&2
exit 1
