#!/usr/bin/env bash
# EAG (Expert Agent Gateway) 一键安装脚本
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/rainy198810-cmyk/eag/main/install.sh | sudo bash
#   EAG_BOOTSTRAP_TOKEN=my-secret curl -fsSL https://raw.githubusercontent.com/rainy198810-cmyk/eag/main/install.sh | sudo bash
#
# 完成后会输出 EAG URL 和 bootstrapToken（首次部署），
# 凭这两个信息在主 PMS 后台 → 远程专家部署 (EAG) 完成专家注册。

set -euo pipefail

# ===== 颜色输出 =====
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()   { echo -e "${GREEN}[EAG-INSTALL]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ===== 1. root 权限检查 =====
if [ "$EUID" -ne 0 ]; then
  err "请使用 root 运行: sudo bash $0"
  exit 1
fi

# ===== 2. Node.js (>=18) 检查/安装 =====
NEED_INSTALL=0
if ! command -v node &>/dev/null; then
  NEED_INSTALL=1
else
  NODE_MAJOR=$(node -e 'console.log(parseInt(process.versions.node.split(".")[0]))' 2>/dev/null || echo "0")
  if [ "$NODE_MAJOR" -lt 18 ]; then
    NEED_INSTALL=1
  fi
fi

if [ "$NEED_INSTALL" -eq 1 ]; then
  log "Node.js 未安装或版本 < 18，自动安装..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
    yum install -y nodejs
  else
    err "不支持的包管理器，请手动安装 Node.js >= 18"
    exit 1
  fi
else
  log "Node.js $(node -v) 已安装"
fi

# ===== 3. 克隆/更新 EAG 仓库 =====
INSTALL_DIR="/home/admin/expert-agent-gateway"
SERVICE_USER="admin"
REPO_URL="https://github.com/rainy198810-cmyk/eag.git"

if [ -d "$INSTALL_DIR/.git" ]; then
  log "已存在 EAG 仓库，执行 git pull 升级..."
  cd "$INSTALL_DIR"
  sudo -u "$SERVICE_USER" git pull || warn "git pull 失败，继续使用现有代码"
else
  log "克隆 EAG 仓库到 $INSTALL_DIR..."
  mkdir -p /home/admin
  git clone "$REPO_URL" "$INSTALL_DIR"
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --omit=dev

# ===== 4. 生成 bootstrapToken =====
if [ -n "${EAG_BOOTSTRAP_TOKEN:-}" ]; then
  BOOTSTRAP_TOKEN="$EAG_BOOTSTRAP_TOKEN"
  log "使用环境变量 EAG_BOOTSTRAP_TOKEN"
else
  # 检测是否已部署（token 已设置）
  if [ -f config.json ]; then
    EXISTING_TOKEN=$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' config.json | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    if [ -n "$EXISTING_TOKEN" ]; then
      BOOTSTRAP_TOKEN=""
      log "检测到 EAG 已部署（token 已设置），跳过 bootstrapToken 配置"
    else
      # 首次部署：自动生成
      BOOTSTRAP_TOKEN=$(openssl rand -hex 16)
      log "首次部署，自动生成 bootstrapToken: $BOOTSTRAP_TOKEN"
      echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
      echo -e "${YELLOW}请保存此 bootstrapToken，PMS 部署专家时需要填写！${NC}"
      echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
    fi
  else
    # config.json 不存在：首次部署
    BOOTSTRAP_TOKEN=$(openssl rand -hex 16)
    log "首次部署，自动生成 bootstrapToken: $BOOTSTRAP_TOKEN"
    echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}请保存此 bootstrapToken，PMS 部署专家时需要填写！${NC}"
    echo -e "${YELLOW}════════════════════════════════════════════════════════${NC}"
  fi
fi

# ===== 5. 写入 config.json =====
if [ ! -f config.json ] || [ -n "$BOOTSTRAP_TOKEN" ]; then
  [ -f config.json ] && cp config.json "config.json.bak.$(date +%Y%m%d_%H%M%S)"
  cat > config.json << EOF
{
  "_comment": "PORT 默认 1688，可通过 EAG_PORT 环境变量覆盖；token 由 PMS 首次部署时自动生成",
  "token": "",
  "bootstrapToken": "$BOOTSTRAP_TOKEN",
  "openclawHome": "/home/$SERVICE_USER",
  "openclawCronsPath": "/home/$SERVICE_USER/.openclaw/cron/jobs.json",
  "workspaceRoot": "/home/$SERVICE_USER/.openclaw/workspace",
  "asyncTimeoutMs": 15000,
  "waitTimeoutMs": 600000,
  "cronJobs": {}
}
EOF
  chown "$SERVICE_USER":"$SERVICE_USER" config.json
  log "config.json 写入完成"
else
  log "config.json 已存在且 token 已设置，跳过覆盖"
fi

# ===== 6. 创建 systemd 服务（端口 1688） =====
SERVICE_FILE="/etc/systemd/system/expert-agent-gateway.service"
cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Expert Agent Gateway
After=network.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node src/server.mjs
Restart=always
Environment=NODE_ENV=production
Environment=EAG_PORT=1688

[Install]
WantedBy=multi-user.target
EOF

# ===== 7. 启动 =====
systemctl daemon-reload
systemctl enable expert-agent-gateway
systemctl restart expert-agent-gateway
sleep 2

# ===== 8. 验证 =====
if systemctl is-active --quiet expert-agent-gateway; then
  log "✓ EAG 服务已启动（端口 1688）"
  HEALTH=$(curl -s http://127.0.0.1:1688/api/health 2>/dev/null || echo "")
  if [ -n "$HEALTH" ]; then
    echo "$HEALTH"
    if echo "$HEALTH" | grep -q '"needsBootstrap":true'; then
      IP=$(hostname -I 2>/dev/null | awk '{print $1}')
      log "首次部署状态: needsBootstrap=true"
      log ""
      log "请在主 PMS 后台 → 远程专家部署 (EAG) 填写："
      log "  EAG URL:              http://$IP:1688"
      log "  EAG Bootstrap Token:  $BOOTSTRAP_TOKEN"
      log ""
    elif echo "$HEALTH" | grep -q '"needsBootstrap":false'; then
      log "已部署状态: needsBootstrap=false（token 已设置）"
    fi
  fi
  log ""
  log "服务管理命令:"
  log "  systemctl status expert-agent-gateway"
  log "  journalctl -u expert-agent-gateway -f"
else
  err "EAG 服务启动失败，请检查: journalctl -u expert-agent-gateway -e"
  exit 1
fi
