#!/usr/bin/env bash
# Staged install/update. Existing config, robot key, workspace and rollback release survive.
set -euo pipefail
umask 077
: "${CLOUD_URL:?Set CLOUD_URL to the ROSIDE server origin}"
CLOUD_URL="${CLOUD_URL%/}"
INSTALL_DIR="${ROSIDE_INSTALL_ROOT:-$HOME/.ros2ide}"
SERVICE_DIR="${ROSIDE_SERVICE_DIR:-$HOME/.config/systemd/user}"
CLI_DIR="${ROSIDE_CLI_DIR:-$HOME/.local/bin}"
SERVICE_FILE="$SERVICE_DIR/ros2ide-agent.service"
progress() {
  local update_stage="$1" update_record
  [[ "${ROSIDE_UPDATE_JOB:-}" =~ ^[a-f0-9-]{36}$ ]] || return 0
  update_record=$(printf '{"jobId":"%s","stage":"%s"}' "$ROSIDE_UPDATE_JOB" "$update_stage")
  { mkdir -p "$INSTALL_DIR"; printf '%s\n' "$update_record" > "$INSTALL_DIR/update-progress.json.pending"; mv -f "$INSTALL_DIR/update-progress.json.pending" "$INSTALL_DIR/update-progress.json"; } 2>/dev/null || true
  if [ -n "${ROSIDE_UPDATE_REPORT:-}" ] && [ -n "${ROSIDE_UPDATE_TOKEN:-}" ]; then
    curl -fsS --connect-timeout 3 --max-time 5 -H 'Content-Type: application/json' -H "x-update-token: $ROSIDE_UPDATE_TOKEN" --data "$update_record" "$ROSIDE_UPDATE_REPORT" >/dev/null 2>&1 || true
  fi
}
trap 'code=$?; if [ "$code" -ne 0 ]; then progress failed; fi; exit "$code"' EXIT
trap 'exit 1' TERM INT
progress checking
command -v node >/dev/null && command -v npm >/dev/null && command -v curl >/dev/null
node -e 'if(Number(process.versions.node.split(".")[0])<20)throw Error("Node.js 20+ required; existing Agent was not changed")'
systemctl --user show-environment >/dev/null
mkdir -p "$INSTALL_DIR/releases" "$SERVICE_DIR"
exec 9>"$INSTALL_DIR/update.lock"
flock -n 9 || { echo 'Another Agent update is running'; exit 1; }
STAGE_DIR=$(mktemp -d "$INSTALL_DIR/releases/.staging.XXXXXXXX")
echo 'Preparing Agent release; existing Agent keeps running until verification completes.'
progress downloading
curl -fSsL --connect-timeout 15 --max-time 180 "$CLOUD_URL/agent-release.json" -o "$STAGE_DIR/release.json"
RELEASE_SHA=$(node -e 'const x=require(process.argv[1]),want=process.env.ROSIDE_EXPECT_VERSION;if(!/^[a-f0-9]{64}$/.test(x.sha256)||!/^\d+\.\d+\.\d+$/.test(x.version)||(want&&x.version!==want))throw Error("Invalid release");console.log(x.sha256)' "$STAGE_DIR/release.json")
RELEASE_PATH=$(node -e 'const x=require(process.argv[1]);const expected=`/agent-release/${x.sha256}.tar.gz`;if(x.archive&&x.archive!==expected)throw Error("Invalid archive path");console.log(x.archive||"/agent-release.tar.gz")' "$STAGE_DIR/release.json")
if [ -n "${ROSIDE_EXPECT_SHA256:-}" ] && [ "$RELEASE_SHA" != "$ROSIDE_EXPECT_SHA256" ]; then echo 'Release changed; request update again'; exit 1; fi
curl -fSsL --connect-timeout 15 --max-time 180 "$CLOUD_URL$RELEASE_PATH" -o "$STAGE_DIR/release.tar.gz"
progress verifying
printf '%s  %s\n' "$RELEASE_SHA" "$STAGE_DIR/release.tar.gz" | sha256sum -c -
mkdir "$STAGE_DIR/app"
tar -xzf "$STAGE_DIR/release.tar.gz" --no-same-owner -C "$STAGE_DIR/app"
progress installing
(cd "$STAGE_DIR/app" && timeout 900s npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund && bash agent-native-install.sh && node --check server.js && node --check agent-runtime.js && node -e 'for(const m of ["ws","node-pty","express","bcrypt","cors","mysql2/promise"])require(m)' && node agent-release-smoke.js)
if [ -f "$SERVICE_FILE" ]; then cp -p "$SERVICE_FILE" "$STAGE_DIR/previous.service"; fi
if [ -f "$INSTALL_DIR/config.json" ]; then cp -p "$INSTALL_DIR/config.json" "$STAGE_DIR/previous-config.json"; fi
INSTALL_DIR="$INSTALL_DIR" CLOUD_URL="$CLOUD_URL" RELEASE_SHA="$RELEASE_SHA" node <<'NODE'
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const file=path.join(process.env.INSTALL_DIR,'config.json');let cfg={};if(fs.existsSync(file))cfg=JSON.parse(fs.readFileSync(file,'utf8'));
const url=new URL(process.env.CLOUD_URL);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid cloud URL');
cfg.robot_key=cfg.robot_key||crypto.randomUUID();cfg.cloud_url=url.origin.replace(/^http/,'ws')+'/ws/agent';
cfg.local_secret=cfg.local_secret||crypto.randomBytes(32).toString('base64url');cfg.local_port=Number(cfg.local_port)||3080;
if(cfg.local_enabled===undefined)cfg.local_enabled=true;
cfg.release_sha256=process.env.RELEASE_SHA;
fs.writeFileSync(file+'.pending',JSON.stringify(cfg,null,2),{mode:0o600});fs.renameSync(file+'.pending',file);
NODE
PREVIOUS_TARGET=$(readlink "$INSTALL_DIR/current" || true)
SWITCHED=0
rollback() {
  code=$?
  if [ "$code" -ne 0 ] && [ -f "$STAGE_DIR/previous-config.json" ]; then cp -p "$STAGE_DIR/previous-config.json" "$INSTALL_DIR/config.json"; fi
  if [ "$code" -ne 0 ] && [ "$SWITCHED" -eq 1 ]; then
    echo 'Verification failed; restoring previous service. Staging and logs retained.'
    if [ -n "$PREVIOUS_TARGET" ]; then ln -s "$PREVIOUS_TARGET" "$STAGE_DIR/rollback-link"; mv -Tf "$STAGE_DIR/rollback-link" "$INSTALL_DIR/current"; fi
    if [ -f "$STAGE_DIR/previous.service" ]; then cp -p "$STAGE_DIR/previous.service" "$SERVICE_FILE"; systemctl --user daemon-reload; systemctl --user restart ros2ide-agent || true; else systemctl --user stop ros2ide-agent || true; fi
  fi
  if [ "$code" -ne 0 ]; then progress failed; fi
  exit "$code"
}
trap rollback EXIT
ln -s "$STAGE_DIR/app" "$STAGE_DIR/new-current"
mv -Tf "$STAGE_DIR/new-current" "$INSTALL_DIR/current"
SWITCHED=1
cat > "$SERVICE_FILE" <<SVC
[Unit]
Description=ROSIDE Agent (Online + Local)
After=network.target
[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/current
ExecStart=$(command -v node) $INSTALL_DIR/current/agent.js
Environment=ROSIDE_AGENT_CONFIG=$INSTALL_DIR/config.json
Restart=on-failure
RestartSec=5
KillMode=control-group
UMask=0077
[Install]
WantedBy=default.target
SVC
systemctl --user daemon-reload
systemctl --user enable ros2ide-agent
progress restarting
systemctl --user restart ros2ide-agent
LOCAL_PORT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).local_port' "$INSTALL_DIR/config.json")
LOCAL_ENABLED=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).local_enabled !== false' "$INSTALL_DIR/config.json")
local_endpoint_ready() {
  [ "$LOCAL_ENABLED" = false ] && return 0
  # systemd reaches "active" as soon as Node starts, while the child HTTP
  # server can need another moment to bind its port. Keep expected connection
  # refusals quiet during this bounded startup window.
  curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:$LOCAL_PORT/api/local/info" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{try{if(JSON.parse(s).local!==true)process.exit(1)}catch{process.exit(1)}})' 2>/dev/null
}
READY=0
for attempt in $(seq 1 30); do
  if systemctl --user is-active --quiet ros2ide-agent && local_endpoint_ready; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "Agent startup failed: local endpoint 127.0.0.1:$LOCAL_PORT was not ready after 30 seconds." >&2
  echo 'Service status:' >&2
  systemctl --user --no-pager --full status ros2ide-agent >&2 || true
  echo 'Recent Agent logs:' >&2
  journalctl --user -u ros2ide-agent -n 40 --no-pager >&2 || true
  exit 1
fi
loginctl enable-linger "$USER" 2>/dev/null || true
mkdir -p "$CLI_DIR"
cat > "$CLI_DIR/ros2ide-agent" <<'CLI'
#!/usr/bin/env bash
case "${1:-status}" in
  local) cat "$HOME/.ros2ide/local-access.txt" ;;
  key) node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).robot_key' "$HOME/.ros2ide/config.json" ;;
  logs) journalctl --user -u ros2ide-agent -f ;;
  status|start|stop|restart) systemctl --user "${1:-status}" ros2ide-agent ;;
  *) echo 'Usage: ros2ide-agent {local|key|status|start|stop|restart|logs}' ;;
esac
CLI
chmod 700 "$CLI_DIR/ros2ide-agent"
# A child installer cannot change PATH in the shell that invoked `curl | bash`.
# Make subsequent interactive Bash terminals discover the per-user launcher.
if [ "$CLI_DIR" = "$HOME/.local/bin" ]; then
  ROSIDE_PATH_MARKER='# ROSIDE Agent CLI path'
  if ! grep -Fq "$ROSIDE_PATH_MARKER" "$HOME/.bashrc" 2>/dev/null; then
    cat >> "$HOME/.bashrc" <<'BASHRC'

# ROSIDE Agent CLI path
case ":$PATH:" in
  *:"$HOME/.local/bin":*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
BASHRC
  fi
fi
progress ready
echo "Agent $(node -p 'require(process.argv[1]).version' "$STAGE_DIR/release.json") ready. Robot key/config preserved. Previous service: $STAGE_DIR/previous.service"
echo "Local URL: $HOME/.ros2ide/local-access.txt (open on robot or enter through the Cloud robot page)"
if command -v ros2ide-agent >/dev/null 2>&1; then
  echo "Agent CLI: $(command -v ros2ide-agent)"
else
  echo "Agent CLI installed: $CLI_DIR/ros2ide-agent"
  echo "Enable it in this terminal now: export PATH=\"$CLI_DIR:\$PATH\""
fi
echo 'Use an isolated trusted LAN for HTTP. No firewall rules or ROS packages were changed.'
