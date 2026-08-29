#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  ROS2 IDE — Agent Install Script
#  รันบนเครื่อง Robot: curl -sSL <YOUR_SERVER>/install.sh | bash
# ═══════════════════════════════════════════════════════════════

set -e

# Server injects its public URL when this file is downloaded.
CLOUD_URL="${CLOUD_URL:-__CLOUD_URL__}"
INSTALL_DIR="$HOME/.ros2ide"
CONFIG_FILE="$INSTALL_DIR/config.json"
SERVICE_FILE="$HOME/.config/systemd/user/ros2ide-agent.service"

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

echo -e "${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║     ROS2 IDE — Agent Installer           ║"
echo "╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. Check requirements ──────────────────────────────────────
echo -e "${YELLOW}[1/6]${NC} Checking requirements..."
if ! command -v node &>/dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
    echo -e "${RED}npm not found!${NC}"; exit 1
fi
echo -e "  ${GREEN}✓${NC} npm $(npm --version)"

# ── 2. Create install dir ──────────────────────────────────────
echo -e "${YELLOW}[2/6]${NC} Creating install directory..."
mkdir -p "$INSTALL_DIR"
echo -e "  ${GREEN}✓${NC} $INSTALL_DIR"

# ── 3. Generate or load robot key ─────────────────────────────
echo -e "${YELLOW}[3/6]${NC} Robot Key..."
if [ -f "$CONFIG_FILE" ]; then
    ROBOT_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).robot_key)")
    echo -e "  ${GREEN}✓${NC} Existing key: $ROBOT_KEY"
else
    # Generate UUID v4
    ROBOT_KEY=$(node -e "console.log(require('crypto').randomUUID())")
fi

# ── 4. อัปเดต/บันทึก Config ใหม่เสมอ ────────────────────────────
# Convert http(s):// to wss:// and append /ws/agent
WS_URL=$(echo "$CLOUD_URL" | sed 's|^https://|wss://|; s|^http://|ws://|')
WS_URL="${WS_URL%/ws/agent}/ws/agent"
echo "{\"robot_key\":\"$ROBOT_KEY\",\"cloud_url\":\"$WS_URL\"}" > "$CONFIG_FILE"
echo -e "  ${GREEN}✓${NC} Config saved (URL: $WS_URL)"
echo -e "  ${GREEN}✓${NC} Robot key: ${CYAN}$ROBOT_KEY${NC}"

# ── 5. Install agent files ─────────────────────────────────────
echo -e "${YELLOW}[4/6]${NC} Installing agent..."

# Download agent.js from server
curl -sSf "${CLOUD_URL}/agent-download" -o "$INSTALL_DIR/agent.js" 2>/dev/null || {
    echo -e "${RED}Cannot download agent.js from ${CLOUD_URL}/agent-download${NC}"
    echo "Please make sure server is running and accessible."
    exit 1
}

# Create package.json
cat > "$INSTALL_DIR/package.json" << 'PKG'
{
  "name": "ros2ide-agent",
  "version": "2.0.0",
  "main": "agent.js",
  "dependencies": {
    "ws": "^8.21.0",
    "node-pty": "^1.0.0"
  }
}
PKG

cd "$INSTALL_DIR"
echo "Installing npm dependencies..."
npm install --silent 2>/dev/null || npm install
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# USB/ACM serial ports are normally root:dialout (0660). Keep the Agent as the
# logged-in user and grant that user the standard serial-device group.
if getent group dialout >/dev/null 2>&1; then
    if id -nG "$USER" | tr ' ' '\n' | grep -qx dialout; then
        echo -e "  ${GREEN}✓${NC} Serial access (dialout) already enabled"
    elif sudo usermod -aG dialout "$USER"; then
        echo -e "  ${GREEN}✓${NC} Added $USER to dialout (effective after logout/login or reboot)"
    else
        echo -e "  ${YELLOW}!${NC} Run: sudo usermod -aG dialout $USER"
    fi
fi

# Keep USB serial ownership consistent after every unplug/replug. Existing
# ports also receive a per-user ACL so the Agent can use them immediately,
# without waiting for the next login session.
sudo tee /etc/udev/rules.d/70-roside-serial.rules >/dev/null << 'UDEV'
KERNEL=="ttyUSB[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyACM[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyAMA[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyTHS[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="rfcomm[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
UDEV
sudo udevadm control --reload-rules 2>/dev/null || true
if command -v setfacl >/dev/null 2>&1; then
    for SERIAL_PORT in /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/ttyTHS* /dev/rfcomm*; do
        [ -c "$SERIAL_PORT" ] && sudo setfacl -m "u:$USER:rw" "$SERIAL_PORT"
    done
fi

# ── 6. Create systemd service (user) ──────────────────────────
echo -e "${YELLOW}[5/6]${NC} Setting up auto-start service..."
mkdir -p "$(dirname $SERVICE_FILE)"

cat > "$SERVICE_FILE" << SVC
[Unit]
Description=ROS2 IDE Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/agent.js
Restart=on-failure
RestartSec=5
Environment=CLOUD_URL=$CLOUD_URL
Environment=ROBOT_KEY=$ROBOT_KEY

[Install]
WantedBy=default.target
SVC

systemctl --user daemon-reload 2>/dev/null || true
systemctl --user enable ros2ide-agent 2>/dev/null || true
systemctl --user start  ros2ide-agent 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Service registered (ros2ide-agent)"

# เปิดใช้งาน Linger เพื่อให้ Service ทำงานทันทีตอนเปิดเครื่อง โดยไม่ต้องรอ user login
loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" 2>/dev/null || true
echo -e "  ${GREEN}✓${NC} Enabled auto-start on boot (loginctl linger)"

# ── 7. Done ────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Installation Complete! ✓                ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Robot Key: ${CYAN}${ROBOT_KEY}${NC}"
echo ""
echo -e "  ${YELLOW}➤ นำ Robot Key นี้ไปกรอกในหน้าเว็บ Add Robot${NC}"
echo ""
echo -e "  Commands:"
echo -e "    Check status:  ${CYAN}ros2ide-agent status${NC}"
echo -e "    Restart agent: ${CYAN}ros2ide-agent restart${NC}"
echo -e "    View logs:     ${CYAN}ros2ide-agent logs${NC}"
echo -e "    Get key:       ${CYAN}ros2ide-agent key${NC}"
echo -e "    Change URL:    ${CYAN}ros2ide-agent url <new_url>${NC}"
echo -e "    Serial access: ${CYAN}ros2ide-agent serial-fix${NC}"
echo -e "    Uninstall:     ${CYAN}ros2ide-agent uninstall${NC}"
echo ""

# ── 8. Create convenient CLI shortcut ──────────────────────────
# สร้างโฟลเดอร์ให้ชัวร์ก่อน ป้องกัน Permission denied
if touch "/usr/local/bin/ros2ide-agent" 2>/dev/null; then
  CLI_PATH="/usr/local/bin/ros2ide-agent"
else
  mkdir -p "$HOME/.local/bin"
  CLI_PATH="$HOME/.local/bin/ros2ide-agent"
  
  # เพิ่มลงใน PATH ชั่วคราว (ถ้าเครื่องยังไม่มีใน PATH)
  if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
      export PATH="$HOME/.local/bin:$PATH"
      echo -e "  ${YELLOW}Note: Added $HOME/.local/bin to PATH. (You might need to restart terminal)${NC}"
  fi
fi

cat > "$CLI_PATH" << 'CLI'
#!/bin/bash
CONFIG="$HOME/.ros2ide/config.json"
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

case "$1" in
  status) systemctl --user status ros2ide-agent ;;
  start)  systemctl --user start  ros2ide-agent ;;
  stop)   systemctl --user stop   ros2ide-agent ;;
  restart)
          echo -e "${YELLOW}Restarting ROS2 IDE Agent...${NC}"
          systemctl --user restart ros2ide-agent
          echo -e "${GREEN}✓ Service restarted successfully.${NC}"
          ;;
  logs)   journalctl --user -u ros2ide-agent -f ;;
  key)    node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).robot_key)" 2>/dev/null || echo "Key not found" ;;
  serial-fix)
          echo -e "${YELLOW}Enabling USB/ACM serial access for $USER...${NC}"
          sudo usermod -aG dialout "$USER"
          sudo tee /etc/udev/rules.d/70-roside-serial.rules >/dev/null << 'SERIAL_UDEV'
KERNEL=="ttyUSB[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyACM[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyAMA[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="ttyTHS[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
KERNEL=="rfcomm[0-9]*", MODE="0660", GROUP="dialout", TAG+="uaccess"
SERIAL_UDEV
          sudo udevadm control --reload-rules 2>/dev/null || true
          if command -v setfacl >/dev/null 2>&1; then
              for PORT in /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/ttyTHS* /dev/rfcomm*; do
                  [ -e "$PORT" ] && sudo setfacl -m "u:$USER:rw" "$PORT"
              done
          else
              for PORT in /dev/ttyUSB* /dev/ttyACM* /dev/ttyAMA* /dev/ttyTHS* /dev/rfcomm*; do
                  [ -e "$PORT" ] && sudo chmod 666 "$PORT"
              done
          fi
          systemctl --user restart ros2ide-agent
          echo -e "${GREEN}✓ Current ports updated. Logout/login or reboot once to make dialout permanent.${NC}"
          ;;
  url)
          NEW_URL="$2"
          if [ -z "$NEW_URL" ]; then
              echo -e "${YELLOW}Usage: ros2ide-agent url <new_url>${NC}"
              echo "Example: ros2ide-agent url https://roside.example.edu"
              exit 1
          fi
          
          # ดึง Robot Key เดิมออกมา
          ROBOT_KEY=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).robot_key)" 2>/dev/null)
          if [ -z "$ROBOT_KEY" ]; then
              echo -e "${RED}Error: Cannot find existing Robot Key in config.json${NC}"
              exit 1
          fi
          
          # แปลง http(s):// เป็น ws(s):// และต่อท้ายด้วย /ws/agent
          WS_URL=$(echo "$NEW_URL" | sed 's|^https://|wss://|; s|^http://|ws://|')
          WS_URL="${WS_URL%/ws/agent}/ws/agent"
          
          # อัปเดตไฟล์ Config
          echo "{\"robot_key\":\"$ROBOT_KEY\",\"cloud_url\":\"$WS_URL\"}" > "$CONFIG"
          echo -e "${GREEN}✓ Cloud URL updated to: $WS_URL${NC}"
          
          # Restart service เพื่อใช้ URL ใหม่
          echo -e "${YELLOW}Restarting ROS2 IDE Agent to apply changes...${NC}"
          systemctl --user restart ros2ide-agent
          echo -e "${GREEN}✓ Agent is connecting to the new URL.${NC}"
          ;;
  uninstall)
          echo -e "${YELLOW}Uninstalling ROS2 IDE Agent...${NC}"
          
          echo -n "  - Stopping service (might take a few seconds)... "
          systemctl --user stop ros2ide-agent 2>/dev/null || true
          echo -e "${GREEN}OK${NC}"
          
          echo -n "  - Removing systemd service... "
          systemctl --user disable ros2ide-agent 2>/dev/null || true
          rm -f "$HOME/.config/systemd/user/ros2ide-agent.service"
          systemctl --user daemon-reload 2>/dev/null || true
          echo -e "${GREEN}OK${NC}"
          
          echo -n "  - Deleting agent files (~/.ros2ide)... "
          rm -rf "$HOME/.ros2ide"
          echo -e "${GREEN}OK${NC}"
          
          echo -n "  - Removing CLI shortcut... "
          rm -f "$0" 2>/dev/null || sudo rm -f "$0" 2>/dev/null || true
          echo -e "${GREEN}OK${NC}"
          
          echo -e "${GREEN}ROS2 IDE Agent uninstalled successfully. 👋${NC}"
          ;;
  *)      echo "Usage: ros2ide-agent {status|start|stop|restart|logs|key|url|serial-fix|uninstall}" ;;
esac
CLI

chmod +x "$CLI_PATH"
echo -e "  ${GREEN}✓${NC} Created shortcut at $CLI_PATH"
