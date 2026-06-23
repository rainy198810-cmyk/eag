import express from 'express';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      token: process.env.EAG_TOKEN || '',
      bootstrapToken: process.env.EAG_BOOTSTRAP_TOKEN || '',
      openclawHome: '/home/admin',
      openclawCronsPath: '/home/admin/.openclaw/cron/jobs.json',
      workspaceRoot: '/home/admin/.openclaw/workspace',
      asyncTimeoutMs: 15000,
      waitTimeoutMs: 600000,
      cronJobs: {}
    };
  }
  const data = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  // 兼容：早期 config.json 没有 bootstrapToken 字段
  if (typeof data.bootstrapToken === 'undefined') {
    data.bootstrapToken = process.env.EAG_BOOTSTRAP_TOKEN || '';
  }
  return data;
}

let config = loadConfig();
const PORT = process.env.EAG_PORT || 1688;

function saveConfig() {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const app = express();
app.use(express.json({ limit: '5mb' }));

function auth(req, res, next) {
  const a = req.get('authorization') || '';
  const provided = a.replace(/^Bearer\s+/i, '');

  // 优先：长期 token
  if (config.token && provided === config.token) return next();

  // 备选：bootstrap token（仅用于首次部署，安装时一次性使用）
  if (config.bootstrapToken && provided === config.bootstrapToken) {
    req._viaBootstrap = true;
    return next();
  }

  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

// 健康检查（无需鉴权）
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'expert-agent-gateway',
    version: '1.0.0',
    experts: Object.keys(config.cronJobs || {}),
    needsBootstrap: !config.token,  // 是否需要首次部署（token 还没设置）
    hasBootstrapToken: !!config.bootstrapToken,
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

// 把毫秒转成 openclaw 的 --every 格式（10m / 1h / 30s / 500ms）
function msToEveryDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '10m';
  if (n % 3600000 === 0) return `${n / 3600000}h`;
  if (n % 60000 === 0) return `${n / 60000}m`;
  if (n % 1000 === 0) return `${n / 1000}s`;
  return `${n}ms`;
}

// 安装 cron job 到 OpenClaw（使用 openclaw cron add CLI，而不是直接写 jobs.json）
app.post('/api/admin/install-cron', auth, async (req, res) => {
  const { cronJob, setToken } = req.body || {};
  if (!cronJob || !cronJob.name || !cronJob.agentId || !cronJob.payload?.message) {
    return res.status(400).json({ ok: false, error: 'cronJob { name, agentId, payload.message } required' });
  }

  // 首次部署：使用 bootstrap 调用，可顺便设置长期 token
  if (req._viaBootstrap && setToken) {
    config.token = String(setToken);
  }

  // 1. 若存在旧的同名/同 agentId 任务，先用 CLI 移除
  const oldJobId = config.cronJobs?.[cronJob.agentId];
  if (oldJobId) {
    try {
      execSync(`openclaw cron rm "${oldJobId}"`, {
        stdio: 'pipe',
        env: { ...process.env, HOME: config.openclawHome || '/home/admin' }
      });
    } catch (e) {
      // 旧 job 不存在，忽略
    }
  }

  // 2. 用 CLI 添加新 cron job
  const schedule = cronJob.schedule || {};
  const every = schedule.kind === 'every'
    ? msToEveryDuration(schedule.everyMs)
    : '10m';
  const session = cronJob.sessionTarget || 'isolated';
  const sessionKey = cronJob.sessionKey || `agent:${cronJob.agentId}:main`;
  const enabledFlag = cronJob.enabled ? '' : '--disabled';
  // delivery.mode: 'silent' / 'announce'
  const deliverFlag = cronJob.delivery?.mode === 'announce' ? '--announce' : '--no-deliver';

  const args = [
    'openclaw', 'cron', 'add',
    '--name', JSON.stringify(cronJob.name),
    '--agent', JSON.stringify(cronJob.agentId),
    '--message', JSON.stringify(cronJob.payload.message),
    '--session', session,
    '--session-key', JSON.stringify(sessionKey),
    '--every', every,
    '--json',
  ];
  if (enabledFlag) args.push(enabledFlag);
  if (deliverFlag) args.push(deliverFlag);

  let addOutput;
  try {
    addOutput = execSync(args.join(' '), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: config.openclawHome || '/home/admin' }
    }).toString();
  } catch (e) {
    const stderr = e.stderr?.toString() || e.message;
    return res.status(500).json({ ok: false, error: `openclaw cron add 失败: ${stderr}` });
  }

  // 3. 解析 CLI 返回的 JSON，提取 openclaw 生成的 jobId
  let addedJob;
  try {
    const jsonMatch = addOutput.match(/\{[\s\S]*\}/);
    addedJob = JSON.parse(jsonMatch ? jsonMatch[0] : addOutput);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `无法解析 openclaw cron add 输出: ${addOutput}` });
  }
  const newJobId = addedJob.id;
  if (!newJobId) {
    return res.status(500).json({ ok: false, error: `openclaw cron add 未返回 id: ${addOutput}` });
  }

  // 4. 更新本机配置
  config.cronJobs = config.cronJobs || {};
  config.cronJobs[cronJob.agentId] = newJobId;
  saveConfig();

  res.json({
    ok: true,
    jobId: newJobId,
    expertId: cronJob.agentId,
    cronCount: config.cronJobs ? Object.keys(config.cronJobs).length : 0,
  });
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

// 卸载：使用 openclaw cron rm 删除任务，删除 workspace
app.post('/api/admin/uninstall', auth, (req, res) => {
  const { expertId, workspaceRoot } = req.body || {};
  if (!expertId) return res.status(400).json({ ok: false, error: 'expertId required' });

  // 1. 从本机 config 找到 jobId，调用 openclaw cron rm 删除
  const jobId = config.cronJobs?.[expertId];
  let removedFromCrons = 0;
  if (jobId) {
    try {
      execSync(`openclaw cron rm "${jobId}"`, {
        stdio: 'pipe',
        env: { ...process.env, HOME: config.openclawHome || '/home/admin' }
      });
      removedFromCrons = 1;
    } catch (e) {
      // job 不存在，忽略
    }
  }

  // 2. 兼容清理：openclaw 内部可能还有遗留的同 name 任务
  // 通过 openclaw cron list --json 查找并删除同 name 的任务
  try {
    const listOutput = execSync('openclaw cron list --json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: config.openclawHome || '/home/admin' }
    }).toString();
    const jsonMatch = listOutput.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const jobs = JSON.parse(jsonMatch[0]);
      const targetName = `football-write-${expertId}`;
      for (const j of jobs) {
        if (j.name === targetName && j.id !== jobId) {
          try {
            execSync(`openclaw cron rm "${j.id}"`, {
              stdio: 'pipe',
              env: { ...process.env, HOME: config.openclawHome || '/home/admin' }
            });
            removedFromCrons += 1;
          } catch (e) {
            // 忽略
          }
        }
      }
    }
  } catch (e) {
    // list 失败时忽略
  }

  // 3. 清理 workspace 目录
  const wroot = workspaceRoot || config.workspaceRoot
    || join(config.openclawHome || '/home/admin', '.openclaw', 'workspace');
  let removedWorkspace = false;
  try {
    const ws = join(wroot, expertId);
    if (existsSync(ws)) {
      rmSync(ws, { recursive: true, force: true });
      removedWorkspace = true;
    }
  } catch (e) {
    // 忽略
  }

  // 4. 清理本机 config
  if (config.cronJobs) delete config.cronJobs[expertId];
  saveConfig();

  res.json({ ok: true, expertId, removedFromCrons, removedWorkspace, jobId });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[EAG] Expert Agent Gateway listening on :${PORT}`);
  console.log(`[EAG] openclawHome: ${config.openclawHome}`);
  console.log(`[EAG] cronsPath: ${config.openclawCronsPath}`);
  console.log(`[EAG] workspaceRoot: ${config.workspaceRoot}`);
  console.log(`[EAG] Configured experts: ${Object.keys(config.cronJobs || {}).join(', ') || '(none)'}`);
});
