#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run this installer with sudo.' >&2
  exit 1
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
binary="$source_dir/roside-cluster-worker"
config="$source_dir/config.json"
if [[ ! -f "$binary" || ! -f "$config" ]]; then
  echo 'Put roside-cluster-worker, config.json, and install.sh in the same directory.' >&2
  exit 1
fi

workspace_root=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["workspace_root"])' "$config")
workspace_gid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("workspace_gid",""))' "$config")
if [[ ! "$workspace_root" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
  echo 'workspace_root must be an absolute path without spaces.' >&2
  exit 1
fi
if ! mountpoint -q -- "$workspace_root"; then
  echo "Mount the Master Cluster workspace at $workspace_root first." >&2
  exit 1
fi
if [[ ! "$workspace_gid" =~ ^[0-9]+$ ]] || ((workspace_gid < 40001 || workspace_gid > 55000)); then
  echo 'Master did not provide a valid Cluster workspace group.' >&2
  exit 1
fi

group_name="roside-cluster-$((workspace_gid - 40000))"
if getent group "$group_name" >/dev/null; then
  if [[ $(getent group "$group_name" | cut -d: -f3) != "$workspace_gid" ]]; then
    echo 'Cluster workspace group has a different GID.' >&2
    exit 1
  fi
elif getent group "$workspace_gid" >/dev/null; then
  echo 'Cluster workspace GID is already in use.' >&2
  exit 1
else
  groupadd -g "$workspace_gid" "$group_name"
fi

if ! id -u roside-cluster >/dev/null 2>&1; then
  useradd --system --gid "$group_name" --home-dir /var/lib/roside-cluster --create-home --shell /usr/sbin/nologin roside-cluster
else
  usermod -g "$group_name" roside-cluster
fi
if ! runuser -u roside-cluster -- test -w "$workspace_root"; then
  echo "The roside-cluster account cannot write to $workspace_root. Fix mount permissions." >&2
  exit 1
fi

install -d -m 0700 -o roside-cluster -g roside-cluster /etc/roside-cluster
install -m 0755 "$binary" /usr/local/bin/roside-cluster-worker
install -m 0600 -o roside-cluster -g roside-cluster "$config" /etc/roside-cluster/config.json
cat > /etc/systemd/system/roside-cluster-worker.service <<UNIT
[Unit]
Description=ROSIDE Cluster Worker
After=network-online.target remote-fs.target
Wants=network-online.target
RequiresMountsFor=$workspace_root

[Service]
Type=simple
User=roside-cluster
Environment=ROSIDE_CLUSTER_CONFIG=/etc/roside-cluster/config.json
ExecStart=/usr/local/bin/roside-cluster-worker
Restart=always
RestartSec=5
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable roside-cluster-worker.service
systemctl restart roside-cluster-worker.service
systemctl --no-pager --full status roside-cluster-worker.service
