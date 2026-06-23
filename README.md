# Expert Agent Gateway (EAG)

接收 PMS 触发请求并调用本机 OpenClaw cron 任务的独立 Express 服务。

**默认端口：1688**（可通过 `EAG_PORT` 环境变量覆盖）

## 一键部署（推荐）

新服务器 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/rainy198810-cmyk/eag/main/install.sh | sudo bash
```

脚本自动完成：
- Node.js (≥18) 安装
- 仓库克隆 + 依赖安装
- bootstrapToken 自动生成
- systemd 服务创建 + 启动
- 健康检查

详细文档请参考 [DEPLOY.md](./DEPLOY.md)。

## 手动部署（如有特殊需求）

### 1. 安装依赖

```bash
cd /home/admin/expert-agent-gateway
npm install
```

### 2. 配置 `config.json`

```json
{
  "_comment": "PORT 默认 1688，可通过 EAG_PORT 环境变量覆盖；token 由 PMS 首次部署时自动生成",
  "token": "",
  "bootstrapToken": "your-bootstrap-secret",
  "openclawHome": "/home/admin",
  "openclawCronsPath": "/home/admin/.openclaw/cron/jobs.json",
  "workspaceRoot": "/home/admin/.openclaw/workspace",
  "asyncTimeoutMs": 15000,
  "waitTimeoutMs": 600000,
  "cronJobs": {}
}
```

### 3. systemd 服务

复制以下内容到 `/etc/systemd/system/expert-agent-gateway.service`：

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
Environment=EAG_PORT=1688
Environment=EAG_TOKEN=your-long-term-token

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable expert-agent-gateway
sudo systemctl start expert-agent-gateway
sudo systemctl status expert-agent-gateway
```

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/health` | 否 | 健康检查（返回 `needsBootstrap`、`hasBootstrapToken`） |
| POST | `/api/trigger` | 是 | 触发专家 |
| GET | `/api/experts` | 是 | 查询专家 |
| PUT | `/api/config/cron-jobs` | 是 | 注册 cronJobs 映射 |
| DELETE | `/api/config/cron-jobs/:expertId` | 是 | 删除专家映射 |
| POST | `/api/admin/install-cron` | 是 / bootstrap | 安装 cron job 到 OpenClaw |
| POST | `/api/admin/install-files` | 是 | 推送 agent MD 文件到 workspace |
| POST | `/api/admin/uninstall` | 是 | 卸载专家 |

**bootstrap 鉴权**（仅 `install-cron` 支持）：首次部署时（`needsBootstrap=true`），可用 `bootstrapToken` 鉴权，可附带 `setToken` 字段设置长期 token。

## 调用示例

### 健康检查

```bash
curl http://127.0.0.1:1688/api/health
```

### 触发专家

```bash
curl -X POST http://127.0.0.1:1688/api/trigger \
  -H "Authorization: Bearer your-long-term-token" \
  -H "Content-Type: application/json" \
  -d '{"expertId":"expert1","waitForCompletion":false,"timeout":15000}'
```
