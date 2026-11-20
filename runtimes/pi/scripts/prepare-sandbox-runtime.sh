#!/usr/bin/env bash
set -euo pipefail

runtime=${1:?Usage: bash prepare-sandbox-runtime.sh ABSOLUTE_NEW_DIR ABSOLUTE_NODE_BINARY}
node=${2:?Provide the preinstalled Node.js binary}
[[ "$runtime" = /* && "$node" = /* ]]
python=/usr/bin/python3.12
[[ "$("$node" --version)" = v22.23.2 ]]
[[ "$("$python" --version)" = 'Python 3.12.3' ]]
[[ "$("$python" -c 'from PIL import __version__; print(__version__)')" = 10.2.0 ]]

umask 022
mkdir -- "$runtime"
mkdir -p -- "$runtime"/{usr/bin,usr/lib/python3/dist-packages,dev,proc,workspace,tmp}
bin=(bash cat chmod cp cut date find grep head ls mkdir mv rm sed sleep sort stat tail touch tr wc)
for name in "${bin[@]}"; do
  install -m 0755 "/usr/bin/$name" "$runtime/usr/bin/$name"
done
install -m 0755 "$node" "$runtime/usr/bin/node"
install -m 0755 "$python" "$runtime/usr/bin/python3"
ln -s python3 "$runtime/usr/bin/python"
cp -a /usr/lib/python3.12 "$runtime/usr/lib/"
python_distributions=(PIL pillow-10.2.0.egg-info)
for entry in "${python_distributions[@]}"; do
  cp -a "/usr/lib/python3/dist-packages/$entry" "$runtime/usr/lib/python3/dist-packages/"
done

# Preserve dynamic loader paths while copying only dependencies of the installed files.
find "$runtime/usr" -type f \( -perm /111 -o -name '*.so*' \) -print0 |
  while IFS= read -r -d '' image; do
    if [[ "$(head -c 4 "$image")" != $'\x7fELF' ]]; then continue; fi
    libraries=$(ldd "$image")
    if [[ "$libraries" == *"not found"* ]]; then
      printf 'Missing runtime library for %s\n' "$image" >&2
      exit 1
    fi
    awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }' <<< "$libraries"
  done | sort -u |
  while IFS= read -r library; do
    cp -L --parents -- "$library" "$runtime"
  done

# Write the marker only after staging succeeds.
{
  "$node" --version
  "$python" --version
  dpkg-query -W bash coreutils python3.12-minimal python3.12 libpython3.12-stdlib python3-pil bubblewrap
  printf 'node sha256\t%s\n' "$(sha256sum "$runtime/usr/bin/node" | cut -d ' ' -f 1)"
  printf 'python distribution entry\t%s\n' "${python_distributions[@]}"
} > "$runtime/pi-runtime-manifest"
