'use strict';

/*
 * 决策模型审核层测试 —— 本地 mock HTTP 服务，不访问外网。
 * 运行：node tests/decision-model.js
 *
 * 覆盖：B5 五问请求形状、默认严格度下的 ask/silent、kind 派生（margin/scope）、
 *       q_opaque 执行诊断、q_opaque 缺失、旧协议 fail-open、超时、HTTP 错误、
 *       非法 JSON、硬维度缺失、未配置端点、确定性层已 ask 不调用、默认关闭不请求、
 *       localhost 绕过代理、发送前脱敏与数据最小化、日志留痕。
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
// macOS 的 /var 是指向 /private/var 的符号链接；插件有意按 realpath 归一项目根
const PROJECT_REAL = fs.realpathSync(PROJECT);

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

const QUESTION_KEYS = ['q_loss', 'q_system', 'q_external', 'q_exfil', 'q_opaque'];

// 五个答案；未指定的维度默认 0.01，q_opaque 默认 0.2
function answer(scores, opaque) {
  const all = Object.assign({ q_loss: 0.01, q_system: 0.01, q_external: 0.01, q_exfil: 0.01 }, scores || {});
  const answers = {};
  for (const key of QUESTION_KEYS.slice(0, 4)) answers[key] = { type: 'noul', noul: all[key] };
  if (opaque !== undefined) answers.q_opaque = { type: 'noul', noul: opaque };
  else answers.q_opaque = { type: 'noul', noul: 0.2 };
  return { answers };
}
function defaultAnswer(score, q, opaque) {
  return answer({ [q || 'q_system']: score }, opaque);
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

async function runCase(extraCfg, command) {
  const dir = caseDir();
  const env = baseEnv(writeConfig(dir, extraCfg), dir);
  const r = await runGuard(env, bashPayload(command || 'echo hi'));
  return { r, env, rec: readLastLog(env) };
}

/* ---------- 用例 ---------- */

(async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = 'http://127.0.0.1:' + port + '/v1/systemone';

  await t('q_system 0.98 → ask，理由含 kind/问题名/分数/阈值/strictness', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.98, 'q_system')), delay: 0 };
    hits = 0; lastBody = null;
    const { r, rec } = await runCase();
    assert.strictEqual(r.code, 0);
    assert.ok(r.out.trim(), '期望 ask 输出');
    const j = JSON.parse(r.out);
    assert.strictEqual(j.hookSpecificOutput.permissionDecision,
      'ask');
    assert.strictEqual(j.hookSpecificOutput.permissionDecisionReason,
      '[zcode-fence: 决策模型] 建议确认：system_change（q_system 0.98 ≥ 0.75；strictness=1）');
    assert.strictEqual(hits, 1);
    assert.strictEqual(rec.decision_model.outcome, 'ask');
    assert.strictEqual(rec.decision_model.kind, 'system_change');
    assert.strictEqual(rec.decision_model.strictness, 1);
    assert.strictEqual(rec.decision_model.model, 'fake-model');
    assert.strictEqual(rec.decision_model.scores.q_system, 0.98);
    assert.strictEqual(rec.decision_model.scores.q_opaque, 0.2);
    assert.strictEqual(rec.decision_model.thresholds.q_system, 0.75);
    assert.ok(Math.abs(rec.decision_model.margins.q_system - 0.23) < 1e-9);
    assert.deepStrictEqual(rec.decision_model.crossed, ['system_change']);
    assert.strictEqual(rec.decision_model.opaque_missing, false);
    assert.strictEqual(typeof rec.decision_model.elapsed_ms, 'number');
  });

  await t('q_system 0.74 → silent（低于阈值）', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.74, 'q_system')), delay: 0 };
    hits = 0;
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 1);
    assert.strictEqual(rec.decision_model.outcome, 'silent');
    assert.deepStrictEqual(rec.decision_model.crossed, []);
    assert.strictEqual(rec.decision_model.kind, 'routine');
  });

  await t('q_loss 0.80 等于阈值 → ask', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.80, 'q_loss')), delay: 0 };
    const { r, rec } = await runCase();
    assert.ok(r.out.trim(), '等于阈值也应 ask');
    assert.strictEqual(rec.decision_model.kind, 'irreversible_loss');
  });

  await t('严格度切换：同一组分数在 2 / 1 / 0 下产生不同裁决', async () => {
    // q_system 0.78：档 2（0.80）silent；档 1（0.75）ask
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.78, 'q_system')), delay: 0 };
    const s2 = await runCase({ decision_model_strictness: '2' });
    assert.strictEqual(s2.r.out.trim(), '');
    assert.strictEqual(s2.rec.decision_model.outcome, 'silent');
    assert.strictEqual(s2.rec.decision_model.strictness, 2);
    assert.strictEqual(s2.rec.decision_model.thresholds.q_system, 0.80);
    const s1 = await runCase({ decision_model_strictness: '1' });
    assert.ok(s1.r.out.trim(), '标准档应 ask');
    assert.strictEqual(s1.rec.decision_model.outcome, 'ask');
    // q_loss 0.72：档 1（0.80）silent；档 0（0.70）ask
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.72, 'q_loss')), delay: 0 };
    const l1 = await runCase({ decision_model_strictness: '1' });
    assert.strictEqual(l1.r.out.trim(), '');
    const l0 = await runCase({ decision_model_strictness: '0' });
    assert.ok(l0.r.out.trim(), '宽松档应 ask');
    assert.strictEqual(l0.rec.decision_model.outcome, 'ask');
    assert.strictEqual(l0.rec.decision_model.strictness, 0);
    assert.strictEqual(l0.rec.decision_model.thresholds.q_loss, 0.70);
  });

  await t('非法严格度 → 回退 1 并在 config_notes 留痕', async () => {
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.74, 'q_system')), delay: 0 };
    const { r, rec } = await runCase({ decision_model_strictness: '9' });
    assert.strictEqual(r.out.trim(), '', '0.74 在标准档应 silent；若被当成宽松档会 ask');
    assert.strictEqual(rec.decision_model.strictness, 1);
    assert.ok(rec.config_notes.some((x) => x.indexOf('非法') >= 0), JSON.stringify(rec.config_notes));
  });

  await t('旧 decision_model_threshold 被忽略并留痕', async () => {
    // 旧阈值 0.1 若仍生效会把 0.5 判成 ask
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.5, 'q_system')), delay: 0 };
    const { r, rec } = await runCase({ decision_model_threshold: '0.1' });
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(rec.decision_model.outcome, 'silent');
    assert.ok(rec.config_notes.some((x) => x.indexOf('已废弃') >= 0), JSON.stringify(rec.config_notes));
  });

  await t('多维度跨阈值 → 取 margin 最大者', async () => {
    // system margin 0.23 > loss margin 0.15
    behavior = {
      status: 200,
      body: JSON.stringify(answer({ q_system: 0.98, q_loss: 0.95 })),
      delay: 0,
    };
    const { rec } = await runCase();
    assert.strictEqual(rec.decision_model.kind, 'system_change');
    assert.deepStrictEqual(rec.decision_model.crossed.sort(), ['irreversible_loss', 'system_change']);
  });

  await t('margin 并列 → 按 scope（exfil > external > loss > system）', async () => {
    // loss 与 system margin 都是 0.15
    behavior = {
      status: 200,
      body: JSON.stringify(answer({ q_loss: 0.95, q_system: 0.90 })),
      delay: 0,
    };
    const { rec } = await runCase();
    assert.strictEqual(rec.decision_model.kind, 'irreversible_loss');
  });

  await t('无硬维度跨阈值 + q_opaque 0.92 → silent + code_execution', async () => {
    behavior = { status: 200, body: JSON.stringify(answer({}, 0.92)), delay: 0 };
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(rec.decision_model.outcome, 'silent');
    assert.strictEqual(rec.decision_model.kind, 'code_execution');
    assert.strictEqual(rec.decision_model.scores.q_opaque, 0.92);
  });

  await t('q_opaque 缺失 → 仍可判定，kind=routine 且日志 opaque_missing', async () => {
    const parsed = answer({});
    delete parsed.answers.q_opaque;
    behavior = { status: 200, body: JSON.stringify(parsed), delay: 0 };
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(rec.decision_model.outcome, 'silent');
    assert.strictEqual(rec.decision_model.kind, 'routine');
    assert.strictEqual(rec.decision_model.scores.q_opaque, null);
    assert.strictEqual(rec.decision_model.opaque_missing, true);
  });

  await t('旧单问响应（answers.ask/kind）→ fail-open 并留痕', async () => {
    behavior = {
      status: 200,
      body: JSON.stringify({ answers: { ask: { noul: 0.9 }, kind: { choice: 'data_deletion' } } }),
      delay: 0,
    };
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(rec.decision_model.outcome, 'fail-open');
    assert.ok(/answers\.q_loss/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('缺少任一硬维度 → fail-open 且指出缺失项', async () => {
    const parsed = answer({ q_loss: 0.95 });
    delete parsed.answers.q_exfil;
    behavior = { status: 200, body: JSON.stringify(parsed), delay: 0 };
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(rec.decision_model.outcome, 'fail-open');
    assert.strictEqual(rec.decision_model.error, '响应缺少 answers.q_exfil');
  });

  await t('请求形状：一次 POST、五问、state 含 cwd/allowed_roots', async () => {
    behavior = { status: 200, body: JSON.stringify(answer({}, 0.2)), delay: 0 };
    hits = 0;
    lastBody = null;
    const { r } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.ok(lastBody, '应收到请求体');
    assert.deepStrictEqual(Object.keys(lastBody.questions), QUESTION_KEYS);
    for (const key of QUESTION_KEYS) {
      assert.strictEqual(lastBody.questions[key].type, 'noul', key);
      assert.ok(lastBody.questions[key].instructions, key + ' 缺 instructions');
      assert.ok(lastBody.questions[key].criteria.true, key + ' 缺 criteria.true');
      assert.ok(lastBody.questions[key].criteria.false, key + ' 缺 criteria.false');
    }
    assert.strictEqual(lastBody.questions.ask, undefined);
    assert.strictEqual(lastBody.questions.kind, undefined);
    assert.deepStrictEqual(Object.keys(lastBody.state).sort(),
      ['allowed_roots', 'cwd', 'input', 'project_root', 'tool']);
    assert.strictEqual(lastBody.state.tool, 'Bash');
    assert.strictEqual(lastBody.state.cwd, PROJECT_REAL);
    assert.ok(Array.isArray(lastBody.state.allowed_roots));
    assert.ok(lastBody.state.allowed_roots.indexOf(PROJECT_REAL) >= 0,
      JSON.stringify(lastBody.state.allowed_roots));
    assert.strictEqual(hits, 1);
  });

  await t('cwd 不可归一为绝对路径时不发送', async () => {
    behavior = { status: 200, body: JSON.stringify(answer({}, 0.2)), delay: 0 };
    lastBody = null;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    const payload = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo hi' }, session_id: 'sess-dm',
    };
    const r = await runGuard(env, payload);
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(lastBody.state.cwd, undefined);
    assert.ok(lastBody.state.allowed_roots, '项目根存在时仍发送 allowed_roots');
  });

  await t('无项目根时省略 allowed_roots', async () => {
    behavior = { status: 200, body: JSON.stringify(answer({}, 0.2)), delay: 0 };
    lastBody = null;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    delete env.ZCODE_PROJECT_DIR;
    const payload = {
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'echo hi' }, session_id: 'sess-dm',
    };
    const r = await runGuard(env, payload);
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(lastBody.state.allowed_roots, undefined);
    assert.strictEqual(lastBody.state.cwd, undefined);
    assert.strictEqual(lastBody.state.project_root, '');
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
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(rec.decision_model.outcome, 'fail-open');
    assert.ok(/HTTP 500/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('响应非法 JSON → fail-open 且留痕', async () => {
    behavior = { status: 200, body: '{ not json', delay: 0 };
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.ok(/不是合法 JSON/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('answers 缺失 → fail-open 且留痕', async () => {
    behavior = { status: 200, body: '{"answers":{}}', delay: 0 };
    const { r, rec } = await runCase();
    assert.strictEqual(r.out.trim(), '');
    assert.ok(/answers\.q_loss/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('未配置端点 → 不请求、fail-open 留痕', async () => {
    hits = 0;
    const { r, rec } = await runCase({ decision_model_endpoint: '' });
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 0);
    assert.strictEqual(rec.decision_model.outcome, 'fail-open');
    assert.ok(/端点未配置/.test(rec.decision_model.error));
  });

  await t('非本地 http 端点 → 拒绝调用、fail-open', async () => {
    hits = 0;
    const { r, rec } = await runCase({ decision_model_endpoint: 'http://example.com/v1/systemone' });
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 0);
    assert.ok(/端点非法/.test(rec.decision_model.error), rec.decision_model.error);
  });

  await t('确定性层已 ask → 不调用模型', async () => {
    hits = 0;
    const { r, rec } = await runCase(null, 'rm -rf /');
    assert.ok(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason.indexOf('危险命令') >= 0);
    assert.strictEqual(hits, 0);
    assert.strictEqual(rec.decision_model, undefined);
  });

  await t('默认关闭 → 不发起任何请求', async () => {
    hits = 0;
    const { r, rec } = await runCase({ enable_decision_model: 'false' });
    assert.strictEqual(r.out.trim(), '');
    assert.strictEqual(hits, 0);
    assert.strictEqual(rec.decision_model, undefined);
  });

  await t('localhost 端点绕过环境代理直连', async () => {
    hits = 0;
    const dir = caseDir();
    const env = baseEnv(writeConfig(dir), dir);
    env.HTTP_PROXY = 'http://127.0.0.1:1';
    env.HTTPS_PROXY = 'http://127.0.0.1:1';
    behavior = { status: 200, body: JSON.stringify(defaultAnswer(0.98)), delay: 0 };
    const r = await runGuard(env, bashPayload('echo hi'));
    assert.ok(r.out.trim(), '本地端点应绕过代理并成功');
    assert.strictEqual(hits, 1);
  });

  await t('发送前脱敏 + 数据最小化（只发工具名/输入/项目根/cwd/可写根）', async () => {
    behavior = { status: 200, body: JSON.stringify(answer({})), delay: 0 };
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
    assert.strictEqual(lastBody.state.tool, 'Bash');
    assert.ok(lastBody.state.input.indexOf('echo hi') === 0);
    assert.strictEqual(lastBody.state.project_root, PROJECT_REAL);
  });

  await t('文件工具的路径同样送入模型', async () => {
    behavior = { status: 200, body: JSON.stringify(answer({ q_external: 0.9 })), delay: 0 };
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

  await t('兼容 probability/score 形态', async () => {
    behavior = {
      status: 200,
      body: JSON.stringify({ answers: {
        q_loss: { probability: 0.9 },
        q_system: { score: 0.01 },
        q_external: { noul: 0.01 },
        q_exfil: { noul: 0.01 },
        q_opaque: { score: 0.1 },
      } }),
      delay: 0,
    };
    const { r, rec } = await runCase();
    assert.ok(r.out.trim());
    assert.strictEqual(rec.decision_model.kind, 'irreversible_loss');
  });

  await t('本地 mock 配置 headers 被发送', async () => {
    behavior = { status: 200, body: JSON.stringify(answer({})), delay: 0 };
    const dir = caseDir();
    let seen = null;
    const srv = http.createServer((req, res) => {
      seen = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(answer({})));
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

  await t('代理/NO_PROXY 解析（配置覆盖环境、本机直连）', async () => {
    const g = require(GUARD);
    const ep = (u) => g.parseModelEndpoint(u);
    const target = ep('https://api.example.com/v1/systemone');
    assert.strictEqual(g.resolveProxy(target, { decision_model_proxy: '' },
      { HTTPS_PROXY: 'http://proxy:3128' }).url.host, 'proxy:3128');
    assert.strictEqual(g.resolveProxy(target, { decision_model_proxy: '' },
      { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'api.example.com' }).url, null);
    assert.strictEqual(g.resolveProxy(target, { decision_model_proxy: 'http://cfg:8080' },
      { HTTPS_PROXY: 'http://env:1' }).url.host, 'cfg:8080');
    assert.strictEqual(g.resolveProxy(ep('http://127.0.0.1:9/v1'), { decision_model_proxy: '' },
      { HTTPS_PROXY: 'http://proxy:1' }).url, null);
  });

  server.close();
  console.log('');
  console.log('决策模型测试：' + passed + ' 通过，' + failed + ' 失败');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('runner 崩溃：', e);
  process.exit(1);
});
