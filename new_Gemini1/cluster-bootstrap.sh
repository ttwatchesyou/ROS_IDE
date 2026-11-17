#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $(id -u) -ne 0 ]]; then
  echo 'Run with sudo: sudo bash bootstrap.sh https://YOUR-MASTER' >&2
  exit 1
fi
for program in curl python3 mountpoint; do
  command -v "$program" >/dev/null || { echo "Missing $program" >&2; exit 1; }
done

broker_url=${1:-}
if [[ -z "$broker_url" ]]; then echo 'Master URL is missing from the install command.' >&2; exit 1; fi
broker_url=${broker_url%/}
python3 - "$broker_url" <<'PY'
import sys,urllib.parse
u=urllib.parse.urlparse(sys.argv[1])
if not u.hostname or u.username or u.password or u.path or u.query or u.fragment or not (u.scheme=='https' or u.scheme=='http' and u.hostname in ('localhost','127.0.0.1','::1')):
    raise SystemExit('Master/Broker URL must be an HTTPS origin (HTTP is allowed only on localhost).')
PY

install_code=${2:-}
if [[ -z "$install_code" ]]; then
  read -r -s -p 'รหัสติดตั้งชั่วคราวจากหน้า Cluster: ' install_code
  echo
fi
if [[ ! "$install_code" =~ ^[A-Za-z0-9_-]{24}$ ]]; then
  echo 'Install code format is invalid.' >&2
  exit 1
fi

work_dir=$(mktemp -d /tmp/roside-worker-XXXXXXXX)
trap 'rm -rf -- "$work_dir"' EXIT
printf '%s' "$install_code" | python3 -c 'import json,sys; print(json.dumps({"code":sys.stdin.read()}))' > "$work_dir/request.json"
echo 'กำลังโหลดค่าติดตั้ง Worker...'
curl --fail --silent --show-error --max-time 30 -H 'Content-Type: application/json' --data-binary @"$work_dir/request.json" "$broker_url/api/cluster-bootstrap/config" -o "$work_dir/config.json"
rm -f "$work_dir/request.json"
workspace_root=$(python3 - "$work_dir/config.json" <<'PY'
import json,sys
data=json.load(open(sys.argv[1]))
root=data['workspace_root']
if not isinstance(root,str) or not root.startswith('/') or '..' in root.split('/') or any(c not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_./-' for c in root):
    raise SystemExit('Invalid workspace root')
print(root)
PY
)

if ! mountpoint -q -- "$workspace_root"; then
  mkdir -p -- "$workspace_root"
  mount -- "$workspace_root" 2>/dev/null || true
fi
if ! mountpoint -q -- "$workspace_root"; then
  nfs_source=$(python3 - "$work_dir/config.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1])).get('nfs_source',''))
PY
)
  if [[ ! "$nfs_source" =~ ^[A-Za-z0-9_.:-]+:/[A-Za-z0-9_./-]+$ ]] || [[ "$nfs_source" == *'/../'* ]]; then
    echo 'Master ไม่ได้ส่งที่อยู่โฟลเดอร์ Sim ที่ถูกต้อง' >&2
    exit 1
  fi
  if ! command -v mount.nfs >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nfs-common
  fi
  if ! mount -t nfs -- "$nfs_source" "$workspace_root"; then
    echo 'Master ยังไม่ได้แชร์โฟลเดอร์ Sim ของ Cluster นี้ผ่าน NFS จึงยังติดตั้ง Worker ให้ใช้งาน Sim ไม่ได้' >&2
    echo 'ให้ผู้ดูแลเปิดการแชร์บน Master ก่อน แล้วรันคำสั่งติดตั้งเดิมอีกครั้ง โดยใช้รหัสชั่วคราวที่ยังไม่หมดอายุ' >&2
    exit 1
  fi
  if ! awk -v target="$workspace_root" '$2==target {found=1} END {exit !found}' /etc/fstab; then
    printf '%s %s nfs defaults,_netdev 0 0\n' "$nfs_source" "$workspace_root" >> /etc/fstab
  fi
fi

echo 'Downloading Worker binary and installer...'
printf 'header = "Authorization: Pair %s"\n' "$install_code" | curl --config - --fail --silent --show-error --max-time 600 "$broker_url/api/cluster-bootstrap/worker" -o "$work_dir/roside-cluster-worker"
unset install_code
curl --fail --silent --show-error --max-time 30 "$broker_url/api/cluster-bootstrap/install.sh" -o "$work_dir/install.sh"
chmod 700 "$work_dir/roside-cluster-worker" "$work_dir/install.sh"
cd "$work_dir"
bash install.sh
echo 'Worker installed. Check its connection on the Cluster page.'
