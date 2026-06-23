# Expert Agent Gateway (EAG)

接收 PMS 触发请求并调用本机 OpenClaw cron 任务的独立 Express 服务。

## 部署步骤

### 1. 安装依赖

```bash
cd /home/admin/expert-agent-gateway
npm install
```

### 2. 配置 `config.json`

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
Environment=EAG_PORT=3723
Environment=EAG_TOKEN=your-shared-secret

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable expert-agent-gateway
sudo systemctl start expert-agent-gateway
```

## 端点

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| GET | `/api/health` | 否 | 健康检查 |
| POST | `/api/trigger` | 是 | 触发专家 |
| GET | `/api/experts` | 是 | 查询专家 |
| PUT | `/api/config/cron-jobs` | 是 | 注册 cronJobs 映射 |
| DELETE | `/api/config/cron-jobs/:expertId` | 是 | 删除专家映射 |
| POST | `/api/admin/install-cron` | 是 | 安装 cron job 到 OpenClaw |
| POST | `/api/admin/install-files` | 是 | 推送 agent MD 文件到 workspace |
| POST | `/api/admin/uninstall` | 是 | 卸载专家 |

## 调用示例

### 触发专家

```bash
curl -X POST http://127.0.0.1:3723/api/trigger \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"expertId":"expert1","waitForCompletion":false,"timeout":15000}'
```
