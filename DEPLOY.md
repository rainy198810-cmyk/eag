# Expert Agent Gateway (EAG) 部署指南

## 一、整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                       主 PMS 服务器                              │
│  - 批次管理、发稿任务、专家分配                                   │
│  - 后台「远程专家部署 (EAG)」面板                                 │
└────────────────────────────────────────────────────────────────┘
                            │ HTTP API
                            ↓
┌────────────────────────────────────────────────────────────────┐
│                新专家服务器 (每台)                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │           Expert Agent Gateway (EAG)                     │  │
│  │  - Express 服务，监听 :3723 (可改)                        │  │
│  │  - 接收 PMS 触发，调用本机 openclaw cron run              │  │
│  └──────────────────────────────────────────────────────────┘  │
│                            │                                    │
│                            ↓ execSync                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              OpenClaw Gateway (默认安装)                   │  │
│  │  - 监听 :12124 (OpenClaw 自带)                            │  │
│  │  - 启动 Agent → 调 PMS API 写稿                          │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

**职责划分**：

| 组件 | 职责 | 部署位置 |
|------|------|----------|
| PMS | 批次管理、分配逻辑、数据库 | 主服务器 |
| EAG | 触发队列、专家映射、调用 openclaw | 新专家服务器 |
| OpenClaw | 实际执行 Agent | 新专家服务器（默认安装） |

---

## 二、新专家服务器部署步骤

### 步骤 1：安装 OpenClaw

```bash
# 安装 Node.js (v18+)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt-get install -y nodejs

# 全局安装 OpenClaw
sudo npm install -g openclaw

# 配置 OpenClaw 目录
mkdir -p ~/.openclaw/{agents,cron,workspace,extensions}
```

启动 OpenClaw Gateway（默认监听 12124 端口）：

```bash
HOME=/home/admin openclaw gateway &
# 或注册为 systemd 服务
```

### 步骤 2：部署 EAG 服务

```bash
# 克隆 EAG 仓库
git clone https://github.com/rainy198810-cmyk/eag.git /home/admin/expert-agent-gateway
cd /home/admin/expert-agent-gateway

# 安装依赖
npm install

# 编辑配置
cp config.json config.json.bak  # 备份
nano config.json
```

**`config.json` 配置说明**：

```json
{
  "token": "your-shared-secret-with-pms",
  "openclawHome": "/home/admin",
  "openclawCronsPath": "/home/admin/.openclaw/cron/jobs.json",
  "workspaceRoot": "/home/admin/.openclaw/workspace",
  "asyncTimeoutMs": 15000,
  "waitTimeoutMs": 600000,
  "cronJobs": {}
}
```

- `token`：与 PMS 共享的鉴权 Token（自定义）
- `openclawHome`：openclaw 配置根目录
- `openclawCronsPath`：cron jobs.json 完整路径
- `workspaceRoot`：专家 workspace 父目录

### 步骤 3：启动 EAG 服务

**方式 A：直接运行（测试用）**

```bash
EAG_PORT=3723 EAG_TOKEN=your-shared-secret node src/server.mjs
```

**方式 B：systemd 服务（推荐生产）**

创建 `/etc/systemd/system/expert-agent-gateway.service`：

```ini
[Unit]
Description=Expert Agent Gateway
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/home/admin/expert-agent-gateway
ExecStart=/usr/bin/node src/server.mjs
Restart=always
Environment=NODE_ENV=production
Environment=EAG_PORT=3723
Environment=EAG_TOKEN=your-shared-secret

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable expert-agent-gateway
sudo systemctl start expert-agent-gateway
sudo systemctl status expert-agent-gateway
```

### 步骤 4：验证 EAG

```bash
# 健康检查（无需 token）
curl http://10.0.0.5:3723/api/health

# 带 token 测试
curl -H "Authorization: Bearer your-shared-secret" \
  http://10.0.0.5:3723/api/experts
```

预期输出：

```json
{ "ok": true, "service": "expert-agent-gateway", "experts": [], "version": "1.0.0" }
```

### 步骤 5：开放防火墙端口

```bash
sudo ufw allow from 10.0.0.0/24 to any port 3723
# 或 iptables
sudo iptables -A INPUT -p tcp --dport 3723 -s 10.0.0.0/24 -j ACCEPT
```

确保主 PMS 服务器的 IP 能访问新专家服务器的 :3723 端口。

---

## 三、主 PMS 服务器配置

### 步骤 1：登录 PMS 后台

访问 `http://主PMS_IP:3721/`，进入「设置 → 远程专家部署 (EAG)」面板。

### 步骤 2：部署新专家

填写表单：

| 字段 | 说明 | 示例 |
|------|------|------|
| 专家 ID | 专家唯一标识 | `newExpert1` |
| EAG URL | EAG 服务地址 | `http://10.0.0.5:3723` |
| EAG Token | 与 EAG config.json 一致 | `your-shared-secret` |
| 飞书 Chat ID | 飞书通知群（可选） | `oc_xxxxxx` |
| PMS Base URL | Agent 访问 PMS 的地址（默认本机） | `http://10.0.0.1:3721` |

**重要**：`PMS Base URL` 必须填**主 PMS 的内网地址**，这样新服务器上的 agent 才能访问主 PMS 拉取任务和提交草稿。

点击「**测试连接**」→ 「**部署到 EAG**」。

### 步骤 3：自动部署流程

PMS 后端会执行：

1. **构造 cron job** payload，包含指向主 PMS 的 URL
2. **POST** `EAG/api/admin/install-cron` → 写入新服务器 OpenClaw 的 `jobs.json`
3. **POST** `EAG/api/admin/install-files` → 推送 MD 文件到 agent workspace：
   - `FOOTBALL_PMS_WRITE_GUIDE.md`
   - `skills/football-write/SKILL.md`
4. **保存 EAG 配置**到 `data/expert-gateways.json`

部署成功后会显示 `jobId` 和写入的文件列表。

### 步骤 4：启用专家

部署完成后，还需要在 PMS 「**专家管理**」面板将新专家 ID 添加到 `enabledExperts` 列表：

编辑 `config/experts.json`：

```json
{
  "enabledExperts": [
    "lvyindayingjia",
    "newExpert1",
    "newExpert2"
  ]
}
```

或在后台「专家管理」界面添加。

---

## 四、触发流程

### 自动触发

1. PMS 分配批次给新专家
2. PMS 调用 `agent-trigger.mjs`
3. `runWriteCronJob` 检查 `data/expert-gateways.json`
4. 命中 EAG 配置 → **HTTP POST** `EAG/api/trigger`
5. EAG `execSync('openclaw cron run <jobId> --timeout ...')`
6. OpenClaw 启动 agent
7. Agent 读取 workspace 的 MD 文件
8. Agent 调 `PMS_BASE_URL/api/v1/assignments/<expertId>` 拉取任务
9. Agent 写稿 → POST `PMS_BASE_URL/api/v1/drafts/<batchId>` 提交

### 手动触发

在 PMS 后台「发布任务详情」页面点击「**触发 Agent**」即可。

### 查看日志

```bash
# PMS 端
journalctl -u football-publish-manager -f

# EAG 端
journalctl -u expert-agent-gateway -f
# 或直接运行时
node src/server.mjs  # 输出到 stdout
```

---

## 五、添加多个专家

每台新专家服务器可运行 1 个 EAG 服务，承载任意数量的专家。

### 单机多专家

在主 PMS 后台 EAG 面板，**多次部署**填写不同的 `expertId`，但使用相同的 `EAG URL` 和 `Token`：

```
专家1：expertId=expertA, EAG=http://10.0.0.5:3723
专家2：expertId=expertB, EAG=http://10.0.0.5:3723
专家3：expertId=expertC, EAG=http://10.0.0.5:3723
```

每次部署都会在 EAG 配置中新增 `expertId → jobId` 映射。

### 多机部署

每台机器独立部署 EAG，配置不同的 `EAG URL`：

```
机器1: 3 个专家 → EAG=http://10.0.0.5:3723
机器2: 2 个专家 → EAG=http://10.0.0.6:3723
```

---

## 六、常见问题

### Q1：部署失败 "EAG install-cron 失败: 401"

Token 不匹配。检查：
- EAG `config.json` 的 `token` 字段
- PMS 后台填写的 `EAG Token`

### Q2：Agent 启动但无法连接 PMS

检查 cron job payload 中的 `PMS_BASE_URL`：
- 是否填了主 PMS 的内网地址
- 主 PMS 的 3721 端口是否对外开放
- `curl $PMS_BASE_URL/api/v1/health` 是否可达

### Q3：OpenClaw 命令找不到

确认 `openclaw` 已全局安装：

```bash
which openclaw
# 应输出 /usr/bin/openclaw 或 /usr/local/bin/openclaw
```

EAG 用 `HOME` 环境变量定位 openclaw 配置目录。检查 `config.json` 的 `openclawHome` 是否正确。

### Q4：需要卸载某个专家

PMS 后台 EAG 面板 → 在「已配置的 EAG 专家」列表点击「**卸载**」。

会删除：
- EAG 配置中的 expertId 映射
- OpenClaw jobs.json 中的 cron job
- `data/expert-gateways.json` 中的记录

### Q5：EAG 配置变更后需要重启

修改 `config.json` 后需重启 EAG：

```bash
sudo systemctl restart expert-agent-gateway
```

---

## 七、升级 EAG

```bash
cd /home/admin/expert-agent-gateway
sudo systemctl stop expert-agent-gateway
git pull origin main
npm install
sudo systemctl start expert-agent-gateway
```

---

## 八、安全建议

1. **Token 长度 ≥ 32 位**，使用密码生成器
2. **防火墙限制 EAG 端口**只允许主 PMS IP 访问
3. **定期轮换 Token**：更新 EAG `config.json` 和 PMS `data/expert-gateways.json`
4. **日志审计**：监控 EAG 的 `/api/trigger` 调用频率
5. **OpenClaw jobs.json 备份**：升级 OpenClaw 前备份
