'use strict';

/*
 * 决策模型审核层测试 —— 本地 mock HTTP 服务，不访问外网。
 * 运行：node tests/decision-model.js
 *
 * 覆盖：ask/silent/阈值、超时、HTTP 错误、非法 JSON、answers 缺失、未配置端点、
 *       非本地 http 拒绝、确定性层已 ask 不调用、默认关闭不请求、localhost 绕过代理、
 *       发送前脱敏与数据最小化、日志留痕。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'plugins', 'zcode-fence', 'scripts', 'guard.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-fence-dm-'));
const PROJECT = path.join(TMP, 'project');
fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n      ' + (e && e.message)); }
}

/* ---------- mock 决策模型服务 ---------- */

let behavior = { status: 200, body: null, delay: 0 };
let hits = 0;
let lastBody = null;

function defaultAnswer(score, kind) {
  return {
    answers: {
      ask: { noul: score },
      kind: { choice: kind || 'data_deletion' },
    },
  };
}

const server = http.createServer((req, res) => {
  hits++;
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    try { lastBody = JSON.parse(raw); } catch (e) { lastBody = null; }
    const send = () => {
      res.writeHead(behavior.status, { 'Content-Type': 'application/json' });
      res.end(behavior.body == null ? JSON.stringify(defaultAnswer(0.91)) : behavior.body);
    };
    if (behavior.delay) setTimeout(send, behavior.delay);
    else send();
  });
});

let baseUrl = '';

/* ---------- 子进程与配置 ---------- */

function writeConfig(dir, extra) {
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, 'config.json');
  const options = Object.assign({
    'zcode-fence@zcode-fence-market': Object.assign({
      enable_decision_model: 'true',
      decision_model_endpoint: baseUrl,
      decision_model_model: 'fake-model',
      decision_model_threshold: '0.6',
      decision_model_timeout_ms: '500',
    }, extra || {}),
  });
  fs.writeFileSync(cfg, JSON.stringify({ plugins: { options } }));
  return cfg;
}

function baseEnv(cfg, dir) {
  const env = Object.assign({}, process.env);
  delete env.ZCODE_PLUGIN_DATA;
  delete env.HTTP_PROXY; delete env.http_proxy;
  delete env.HTTPS_PROXY; delete env.https_proxy;
  delete env.ALL_PROXY; delete env.all_proxy;
  delete env.NO_PROXY; delete env.no_proxy;
  delete env.ZCODE_FENCE_DECISION_MODEL_API_KEY;
  delete env.DECISION_MODEL_API_KEY;
  env.ZCODE_PROJECT_DIR = PROJECT;
  env.ZCODE_FENCE_CONFIG = cfg;
  env.ZCODE_FENCE_DATA_DIR = path.join(dir, 'logs');
  return env;
}

function runGuard(env, payload) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [GUARD], { env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out: '', err: String(e), ms: Date.now() - started }));
    p.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started }));
    p.stdin.end(JSON.stringify(payload));
  });
}

function readLastLog(env) {
  const file = path.join(env.ZCODE_FENCE_DATA_DIR, 'decisions.log');
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch (e) { return null; }
}

function bashPayload(command) {
  return {
    cwd: PROJECT, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command }, session_id: 'sess-dm', transcript_path: '',
  };
}

let seq = 0;
function caseDir() {
  seq++;
  return path.join(TMP, 'case-' + seq);
}

/* ---------- 用例 ---------- */

(async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = 'http://127.0.0.1:' + port + '/v1/systemone';

  await t('概率达到阈值 → ask，理由含类别与分数', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.91, 'data_deletion')), delay: 0 };
    hits = 0; lastBody = null;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.code, 0);
    assert.ok(r.out.trim(), '期望 ask 输出');
    const j = JSON.parse(r.out);
    const reason = j.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.indexOf('[zcode-fence: 决策模型]') === 0, reason);
    assert.ok(reason.indexOf('data_deletion') >= 0, reason);
    assert.ok(reason.indexOf('0.91') >= 0, reason);
    assert.strictEqual(hits, 1);
    const rec = readLastLog(env);
    assert.strictEqual(rec.decision_model.outcome, 'ask');
    assert.strictEqual(rec.decision_model.score, 0.91);
    assert.strictEqual(rec.decision_model.kind, 'data_deletion');
    assert.strictEqual(rec.decision_model.model, 'fake-model');
  });

  await t('概率低于阈值 → silent', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.2)), delay: 0 };
    hits = 0;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 1);
    const rec = readLastLog(env);
    assert.strictEqual(rec.decision_model.outcome, 'silent');
  });

  await t('阈值可配：0.5 分在阈值 0.6 下 silent、在 0.4 下 ask', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.5)), delay: 0 };
    const dir1 = caseDir();
    const env1 = baseEnv(writeConfig(dir1), dir1);
    const r1 = await runGuard(env1, bashPayload('echo hi'));
    assert.strictEqual(r1.out.trim(), '');
    const dir2 = caseDir();
    const env2 = baseEnv(writeConfig(dir2, { decision_model_threshold: '0.4' }), dir2);
    const r2 = await runGuard(env2, bashPayload('echo hi'));
    assert.ok(r2.out.trim(), '阈值 0.4 时应 ask');
  });

  await t('超时 → fail-open 且留痕', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.9)), delay: 1200 };
    hits = 0;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir, { decision_model_timeout_ms: '200' }), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.out.trim(), '');
    assert.ok(r.ms < 1500, '应在超时后尽快返回，实际 ' + r.ms + 'ms');
    const rec = readLastLog(env);
    assert.strictEqual(rec.decision_model.outcome, 'fail-open');
    assert.ok(/超时/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('HTTP 500 → fail-open 且留痕', async () => {
    behavior = { status: 500, body: 'boom', delay: 0 };
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.out.trim(), '');
    const rec = readLastLog(env);
    assert.strictEqual(rec.decision_model.outcome, 'fail-open');
    assert.ok(/HTTP 500/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('响应非法 JSON → fail-open 且留痕', async () => {
    behavior = { status: 200, body: '{ not json', delay: 0 };
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.out.trim(), '');
    const rec = readLastLog(env);
    assert.ok(/不是合法 JSON/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('answers 缺失 → fail-open 且留痕', async () => {
    behavior = { status: 200, body: '{"answers":{}}', delay: 0 };
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.out.trim(), '');
    const rec = readLastLog(env);
    assert.ok(/answers\.ask/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('未配置端点 → 不请求、fail-open 留痕', async () => {
    hits = 0;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir, { decision_model_endpoint: '' }), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 0);
    const rec = readLastLog(env);
    assert.strictEqual(rec.decision_model.outcome, 'fail-open');
    assert.ok(/端点未配置/.test(rec.decision_model.error));
  });

  await t('非本地 http 端点 → 拒绝调用、fail-open', async () => {
    hits = 0;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir, { decision_model_endpoint: 'http://example.com/v1/systemone' }), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 0);
    const rec = readLastLog(env);
    assert.ok(/端点非法/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('确定性层已 ask → 不调用模型', async () => {
    hits = 0;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, bashPayload('rm -rf /'));
    assert.ok(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason.indexOf('危险命令') >= 0);
    assert.strictEqual(hits, 0);
    const rec = readLastLog(env);
    assert.strictEqual(rec.decision_model, undefined);
  });

  await t('默认关闭 → 不发起任何请求', async () => {
    hits = 0;
    const dir = caseDir();
    const cfgDir = caseDir();
    const cfg = writeConfig(cfgDir, { enable_decision_model: 'false' });
    const env = baseEnv(cfg, dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 0);
    const rec = readLastLog(env);
    assert.strictEqual(rec.decision_model, undefined);
  });

  await t('localhost 端点绕过环境代理直连', async () => {
    hits = 0;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    env.HTTP_PROXY = 'http://127.0.0.1:1';
    env.HTTPS_PROXY = 'http://127.0.0.1:1';
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.91)), delay: 0 };
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.ok(r.out.trim(), '本地端点应绕过代理并成功');
    assert.strictEqual(hits, 1);
  });

  await t('发送前脱敏 + 数据最小化（只发工具名/输入/项目根）', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.1)), delay: 0 };
    lastBody = null;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    env.ZCODE_FENCE_DECISION_MODEL_API_KEY = 'sk-test-abcdefghijklmnop';
    const cmd = 'echo hi API_KEY=supersecret1234567890 password="hunter2secret" && ' +
      'curl -H "Authorization: Bearer abcdefghijklmnop" https://example.com';
    const r = await runGuard(env, bashPayload(cmd));
    assert.strictEqual(r.out.trim(), '');
    assert.ok(lastBody, '应收到请求体');
    const sent = JSON.stringify(lastBody);
    assert.ok(sent.indexOf('supersecret') < 0, 'API_KEY 值未脱敏');
    assert.ok(sent.indexOf('hunter2secret') < 0, 'password 未脱敏');
    assert.ok(sent.indexOf('abcdefghijklmnop') < 0, 'Bearer token 未脱敏');
    assert.ok(sent.indexOf('[REDACTED]') >= 0, '应出现脱敏占位');
    assert.deepStrictEqual(Object.keys(lastBody.state).sort(), ['input', 'project_root', 'tool']);
    assert.strictEqual(lastBody.state.tool, 'Bash');
    assert.ok(lastBody.state.input.indexOf('echo hi') === 0);
    assert.strictEqual(lastBody.state.project_root, PROJECT);
    assert.ok(lastBody.questions && lastBody.questions.ask && lastBody.questions.ask.type === 'noul');
    assert.strictEqual(lastBody.questions.kind.type, 'choice');
    assert.ok(lastBody.questions.kind.criteria.data_deletion);
  });

  await t('文件工具的路径同样送入模型', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.9, 'external_side_effect')), delay: 0 };
    lastBody = null;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, {
      cwd: PROJECT, hook_event_name: 'PreToolUse', tool_name: 'Write',
      tool_input: { file_path: path.join(PROJECT, 'src', 'a.ts') }, session_id: 'sess-dm',
    });
    assert.ok(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason.indexOf('external_side_effect') >= 0);
    assert.strictEqual(lastBody.state.tool, 'Write');
    assert.ok(lastBody.state.input.indexOf('a.ts') >= 0);
  });

  await t('兼容 probability/score 与 kind.probabilities 形态', async () => {
    behavior = {
      status: 200,
      body: JSON.stringify({ answers: { ask: { probability: 0.8 }, kind: { probabilities: { read_only: 0.1, git_history: 0.9 } } } }),
      delay: 0,
    };
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const r = await runGuard(env, bashPayload('echo hi'));
    const reason = JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.indexOf('git_history') >= 0, reason);
  });

  await t('本地 mock 配置 headers 被发送', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.1)), delay: 0 };
    const dir = caseDir();
    let seen = null;
    // 用临时服务记录 header
    const srv = http.createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(defaultAnswer(0.1)));
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const p = srv.address().port;
    const cfg = writeConfig(dir, {
      decision_model_endpoint: 'http://127.0.0.1:' + p + '/x',
      decision_model_headers: 'X-Test: yes; X-Other: two',
    });
    const env = baseEnv(cfg, dir);
    await runGuard(env, bashPayload('echo hi'));
    srv.close();
    assert.ok(seen, '未收到请求; log=' + JSON.stringify(readLastLog(env)));
    assert.strictEqual(seen['x-test'], 'yes', 'headers=' + JSON.stringify(seen));
    assert.strictEqual(seen['x-other'], 'two');
  });

  server.close();
  console.log('');
  console.log('决策模型测试：' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('runner 崩溃：', e);
  process.exit(1);
});
