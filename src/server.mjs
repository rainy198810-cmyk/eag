import express from 'express';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      token: process.env.EAG_TOKEN || '',
      openclawHome: '/home/admin',
      openclawCronsPath: '/home/admin/.openclaw/cron/jobs.json',
      workspaceRoot: '/home/admin/.openclaw/workspace',
      asyncTimeoutMs: 15000,
      waitTimeoutMs: 600000,
      cronJobs: {}
    };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

let config = loadConfig();
const PORT = process.env.EAG_PORT || 3723;

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const app = express();
app.use(express.json({ limit: '5mb' }));

function auth(req, res, next) {
  const a = req.get('authorization') || '';
  if (!config.token || a === `Bearer ${config.token}`) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// 健康检查（无需鉴权）
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'expert-agent-gateway',
    experts: Object.keys(config.cronJobs || {}),
    version: '1.0.0'
  });
});

// 核心：触发专家
app.post('/api/trigger', auth, (req, res) => {
  const { expertId, waitForCompletion = false, timeout } = req.body || {};
  if (!expertId) return res.status(400).json({ ok: false, error: 'expertId required' });

  const jobId = config.cronJobs?.[expertId];
  if (!jobId) return res.status(404).json({ ok: false, error: `expertId ${expertId} not configured` });

  const ms = waitForCompletion
    ? (timeout || config.waitTimeoutMs || 600000)
    : (timeout || config.asyncTimeoutMs || 15000);
  const expectFinal = waitForCompletion ? ' --expect-final' : '';
  const cmd = `openclaw cron run ${jobId} --timeout ${ms}${expectFinal}`;

  const startedAt = Date.now();
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      timeout: ms + 10000,
      env: { ...process.env, HOME: config.openclawHome || '/home/admin' }
    });
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { ok: true, raw: output };
    res.json({
      ok: true,
      jobId,
      expertId,
      elapsedMs: Date.now() - startedAt,
      output: parsed
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      jobId,
      expertId,
      elapsedMs: Date.now() - startedAt,
      error: err.message,
      stderr: err.stderr?.toString() || ''
    });
  }
});

// 查询专家列表
app.get('/api/experts', auth, (_req, res) => {
  res.json({ ok: true, experts: config.cronJobs || {} });
});

// 注册/更新 cronJobs 映射（PMS 部署时调用）
app.put('/api/config/cron-jobs', auth, (req, res) => {
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'body must be an object { expertId: jobId }' });
  }
  Object.assign(config.cronJobs, body);
  saveConfig();
  res.json({ ok: true, cronJobs: config.cronJobs });
});

// 删除专家
app.delete('/api/config/cron-jobs/:expertId', auth, (req, res) => {
  const { expertId } = req.params;
  delete config.cronJobs[expertId];
  saveConfig();
  res.json({ ok: true, cronJobs: config.cronJobs });
});

// 安装 cron job 到 OpenClaw（追加到 jobs.json）
app.post('/api/admin/install-cron', auth, (req, res) => {
  const { cronJob } = req.body || {};
  if (!cronJob || !cronJob.id || !cronJob.name || !cronJob.agentId) {
    return res.status(400).json({ ok: false, error: 'cronJob { id, name, agentId } required' });
  }

  const cronsPath = config.openclawCronsPath
    || join(config.openclawHome || '/home/admin', '.openclaw', 'cron', 'jobs.json');

  let data = { jobs: [] };
  if (existsSync(cronsPath)) {
    try {
      data = JSON.parse(readFileSync(cronsPath, 'utf-8'));
    } catch (e) {
      return res.status(500).json({ ok: false, error: `failed to parse ${cronsPath}: ${e.message}` });
    }
  }
  data.jobs = data.jobs || [];
  // 移除同名（按 name）和同 id 的旧条目
  data.jobs = data.jobs.filter(j => j.name !== cronJob.name && j.id !== cronJob.id);
  data.jobs.push(cronJob);
  writeFileSync(cronsPath, JSON.stringify(data, null, 2));

  // 更新本机配置
  config.cronJobs[cronJob.agentId] = cronJob.id;
  saveConfig();

  res.json({ ok: true, jobId: cronJob.id, cronCount: data.jobs.length });
});

// 安装 agent MD 文件到 workspace
app.post('/api/admin/install-files', auth, (req, res) => {
  const { expertId, files } = req.body || {};
  if (!expertId || !files || typeof files !== 'object') {
    return res.status(400).json({ ok: false, error: 'expertId and files required' });
  }

  const workspaceRoot = config.workspaceRoot
    || join(config.openclawHome || '/home/admin', '.openclaw', 'workspace');
  const workspace = join(workspaceRoot, expertId);

  const written = [];
  for (const [relPath, content] of Object.entries(files)) {
    const dest = join(workspace, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    written.push(relPath);
  }

  res.json({ ok: true, expertId, filesWritten: written });
});

// 卸载：删除 cron job 和 workspace
app.post('/api/admin/uninstall', auth, (req, res) => {
  const { expertId, cronsPath, workspaceRoot } = req.body || {};
  if (!expertId) return res.status(400).json({ ok: false, error: 'expertId required' });

  const jobId = config.cronJobs?.[expertId];
  const cpath = cronsPath || config.openclawCronsPath
    || join(config.openclawHome || '/home/admin', '.openclaw', 'cron', 'jobs.json');

  let removedFromCrons = 0;
  if (jobId && existsSync(cpath)) {
    try {
      const data = JSON.parse(readFileSync(cpath, 'utf-8'));
      const before = (data.jobs || []).length;
      data.jobs = (data.jobs || []).filter(j => j.id !== jobId && j.name !== `football-write-${expertId}`);
      removedFromCrons = before - data.jobs.length;
      writeFileSync(cpath, JSON.stringify(data, null, 2));
    } catch (e) {
      // 忽略
    }
  }

  delete config.cronJobs[expertId];
  saveConfig();

  res.json({ ok: true, expertId, removedFromCrons, jobId });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[EAG] Expert Agent Gateway listening on :${PORT}`);
  console.log(`[EAG] openclawHome: ${config.openclawHome}`);
  console.log(`[EAG] cronsPath: ${config.openclawCronsPath}`);
  console.log(`[EAG] workspaceRoot: ${config.workspaceRoot}`);
  console.log(`[EAG] Configured experts: ${Object.keys(config.cronJobs || {}).join(', ') || '(none)'}`);
});
