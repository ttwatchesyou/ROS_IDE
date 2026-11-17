#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run with sudo on the Master.' >&2
  exit 1
fi

cluster_id=${1:-}
worker_ip=${2:-}
if [[ ! "$cluster_id" =~ ^[1-9][0-9]{0,4}$ ]] || ((cluster_id > 15000)); then
  echo 'Usage: sudo bash cluster-master-nfs-setup.sh CLUSTER_ID WORKER_TAILSCALE_IPV4' >&2
  exit 1
fi
if ! python3 - "$worker_ip" <<'PY'
import ipaddress,sys
try:
    ip=ipaddress.IPv4Address(sys.argv[1])
    assert ip in ipaddress.IPv4Network('100.64.0.0/10')
except (ValueError,AssertionError):
    raise SystemExit(1)
PY
then
  echo 'Worker IP must be a single Tailscale IPv4 address (100.64.0.0/10).' >&2
  exit 1
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
workspace="$project_dir/sim_ws/CL-$cluster_id"
master_user=$(stat -c %U "$project_dir/sim_ws")
group_name="roside-cluster-$cluster_id"
group_id=$((40000 + cluster_id))
export_file="/etc/exports.d/roside-cluster-$cluster_id.exports"

if ! command -v exportfs >/dev/null || ! command -v setfacl >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y nfs-kernel-server acl
fi

if getent group "$group_name" >/dev/null; then
  if [[ $(getent group "$group_name" | cut -d: -f3) != "$group_id" ]]; then
    echo "Existing $group_name has a different GID; cannot safely change it." >&2
    exit 1
  fi
elif getent group "$group_id" >/dev/null; then
  echo "GID $group_id is already used; cannot safely create $group_name." >&2
  exit 1
else
  groupadd -g "$group_id" "$group_name"
fi

install -d -m 2770 -o "$master_user" -g "$group_name" "$workspace"
# NFS checks the exported path's ancestors as the Worker identity too.
# Grant traversal only to this Cluster group; keep home directory listings private.
parent=$(dirname "$workspace")
while [[ "$parent" != / ]]; do
  setfacl -m "g:$group_name:--x" "$parent"
  parent=$(dirname "$parent")
done
chgrp -R "$group_name" "$workspace"
chmod -R g+rwX "$workspace"
find "$workspace" -type d -exec chmod g+s {} +
find "$workspace" -type d -exec setfacl -m "d:g:$group_name:rwx,d:u:$master_user:rwx,d:m:rwx" {} +
setfacl -R -m "g:$group_name:rwX,u:$master_user:rwX" "$workspace"

install -d -m 0755 /etc/exports.d
if [[ -e "$export_file" ]]; then cp -a "$export_file" "$export_file.bak.$(date +%Y%m%d%H%M%S)"; fi
printf '%s %s(rw,sync,no_subtree_check,root_squash)\n' "$workspace" "$worker_ip" > "$export_file"
chmod 0644 "$export_file"
systemctl enable --now nfs-server
exportfs -ra
exportfs -v | grep -F "$workspace" >/dev/null || { echo 'NFS export did not become active.' >&2; exit 1; }
echo "Cluster $cluster_id workspace is shared only with Worker $worker_ip. Rerun the Worker install command."
