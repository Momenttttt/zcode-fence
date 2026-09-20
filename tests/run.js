'use strict';

/*
 * zcode-fence 验收测试 runner —— 全部用例走 guard.js 的真实入口（--eval / stdin）
 * 运行：node tests/run.js
 *
 * 内置全局不变量（对应需求 §六.15）：
 *   1. 任何用例的期望输出不得是 allow/deny（ask-only 是项目级设计决定）；
 *   2. ask 输出必须严格符合宿主 schema（多余 key 宿主会拒收）；
 *   3. 所有用例 exit code 必须为 0（fail-open 不以非零码结束）；
 *   4. marketplace.json、.zcode-plugin/plugin.json 与其兼容拷贝 .claude-plugin/plugin.json
 *      三处 version/name 必须一致，且 .claude-plugin 拷贝不得漂移（§六.14 + 官方 validate.py 对齐）。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'plugins', 'zcode-fence', 'scripts', 'guard.js');
const TMP = path.join(__dirname, 'tmp');
const PROJECT = path.join(TMP, 'project');
const EXTRA = path.join(TMP, 'extra-root');
const LOGS = path.join(TMP, 'logs');
const CFGDIR = path.join(TMP, 'configs');

/* ---------- 夹具 ---------- */

function setup() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
  fs.mkdirSync(EXTRA, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  fs.mkdirSync(CFGDIR, { recursive: true });

  const opt = (v) => ({ plugins: { options: { 'zcode-fence@zcode-fence-market': v } } });
  const fixtures = {
    'default.json': opt({}),
    'custom.json': opt({ custom_rules: '^special-cleanup' }),
    'invalid.json': opt({ custom_rules: 'special-cleanup;([' }), // 第二段编译失败 → 跳过，第一段仍生效
    'gate-off.json': opt({ enable_danger_gate: 'false' }),
    'fence-off.json': opt({ enable_fence: 'false' }),
    'extra-roots.json': opt({ extra_writable_roots: EXTRA }),
  };
  for (const [name, obj] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(CFGDIR, name), JSON.stringify(obj));
  }
}

/* ---------- 模板与环境 ---------- */

function msysStyle(winPath) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath);
  if (!m) return winPath;
  return '/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
}

function render(s, env) {
  return String(s)
    .replace(/\{PROJECT\}/g, PROJECT)
    .replace(/\{PROJECT_MSYS\}/g, msysStyle(PROJECT))
    .replace(/\{EXTRA\}/g, EXTRA)
    .replace(/\{MEM\}/g, [process.env.HOME || process.env.USERPROFILE, '.zcode', 'cli', 'memories'].join('/'))
    .replace(/\{TEMP\}/g, process.platform === 'win32' ? process.env.TEMP : '/tmp')
    .replace(/\{LONG\}/g, 'a'.repeat(10000));
}

function buildEnv(c) {
  const env = Object.assign({}, process.env);
  delete env.ZCODE_PLUGIN_DATA; // 测试用独立目录，避免污染真实插件数据
  env.ZCODE_FENCE_DATA_DIR = LOGS;
  env.ZCODE_FENCE_CONFIG = path.join(CFGDIR, (c && c.config) ? c.config + '.json' : 'default.json');
  if (c && c.noProject) delete env.ZCODE_PROJECT_DIR;
  else env.ZCODE_PROJECT_DIR = PROJECT;
  return env;
}

/* ---------- 执行 ---------- */

function runGuard(args, env, stdinText) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [GUARD].concat(args), { env });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out: '', err: String(e) }));
    p.on('close', (code) => resolve({ code, out, err }));
    if (stdinText != null) p.stdin.end(stdinText);
    else p.stdin.end();
  });
}

async function runCase(c) {
  if (c.platforms && c.platforms.indexOf(process.platform) < 0) {
    return { skipped: true };
  }
  const env = buildEnv(c);
  let res;
  if (c.mode === 'bash') {
    res = await runGuard(['--eval', render(c.command, env)], env);
  } else if (c.mode === 'file') {
    const flag = c.tool === 'Edit' ? '--eval-edit' : '--eval-write';
    res = await runGuard([flag, render(c.file_path, env)], env);
  } else if (c.mode === 'stdin') {
    const ti = {};
    if (c.command != null) ti.command = render(c.command, env);
    if (c.path != null) ti.path = render(c.path, env);
    if (c.query != null) ti.query = c.query;
    const payload = {
      cwd: PROJECT, hook_event_name: 'PreToolUse', tool_name: c.tool,
      tool_input: ti, tool_use_id: 'test-1', permission_mode: 'bypassPermissions',
      session_id: 'sess-test', transcript_path: '', riskLevel: 'low',
      sideEffectScope: 'workspace', timestamp: new Date().toISOString(),
      toolCallId: 'tc-1', traceId: 'tr-1', turnId: 'tu-1', agent_type: 'main',
    };
    res = await runGuard([], env, JSON.stringify(payload));
  } else if (c.mode === 'stdin-raw') {
    res = await runGuard([], env, c.stdin);
  } else {
    throw new Error('unknown mode: ' + c.mode);
  }
  return { skipped: false, res };
}

/* ---------- 断言 ---------- */

function assertResult(c, res) {
  assert.strictEqual(res.code, 0, 'exit code 应为 0，实际 ' + res.code + '（stderr: ' + res.err.slice(0, 200) + '）');

  if (c.expect === 'silent') {
    assert.strictEqual(res.out.trim(), '', '期望沉默（无输出），实际 stdout: ' + JSON.stringify(res.out.slice(0, 200)));
    return;
  }
  if (c.expect === 'ask') {
    assert.ok(res.out.trim(), '期望 ask 输出，实际无输出');
    let j;
    try { j = JSON.parse(res.out); } catch (e) { throw new Error('ask 输出不是合法 JSON: ' + res.out.slice(0, 200)); }
    assert.deepStrictEqual(Object.keys(j).sort(), ['hookSpecificOutput'], '顶层只允许 hookSpecificOutput 一个 key');
    const h = j.hookSpecificOutput;
    assert.deepStrictEqual(Object.keys(h).sort(),
      ['hookEventName', 'permissionDecision', 'permissionDecisionReason'],
      'hookSpecificOutput key 集合必须精确（多余 key 宿主会拒收）');
    assert.strictEqual(h.hookEventName, 'PreToolUse');
    assert.strictEqual(h.permissionDecision, 'ask');
    assert.ok(h.permissionDecisionReason.indexOf('[zcode-fence:') === 0, 'reason 需带 [zcode-fence: 前缀');
    if (c.strictSchema) {
      assert.ok(h.permissionDecisionReason.length > 10, 'strictSchema：reason 应有实质内容');
    }
    return;
  }
  throw new Error('unknown expect: ' + c.expect);
}

/* ---------- 版本一致性（§六.14）与官方格式静态检查（对齐 zcode-plugins/scripts/validate.py） ---------- */

function staticChecks() {
  const errs = [];
  const mk = JSON.parse(fs.readFileSync(path.join(ROOT, 'marketplace.json'), 'utf8'));
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'zcode-fence', '.zcode-plugin', 'plugin.json'), 'utf8'));
  const cp = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'zcode-fence', '.claude-plugin', 'plugin.json'), 'utf8'));

  // .claude-plugin 是 Claude 兼容清单，官方示例为 .zcode-plugin 的同内容拷贝——整份相等防漂移
  try { assert.deepStrictEqual(cp, pj); }
  catch (e) { errs.push('.claude-plugin/plugin.json 与 .zcode-plugin/plugin.json 内容不一致（兼容拷贝必须同步维护）'); }

  // 市场顶层：owner + 非空 description + description_i18n（en/zh-CN）
  if (!mk.owner || !mk.owner.name) errs.push('marketplace.json 顶层缺 owner.name');
  if (!mk.description) errs.push('marketplace.json 顶层缺非空 description');
  const i18nOK = (o) => o && typeof o.en === 'string' && o.en && typeof o['zh-CN'] === 'string' && o['zh-CN'];
  if (!i18nOK(mk.description_i18n)) errs.push('marketplace.json 顶层 description_i18n 缺 en/zh-CN 非空项');

  const entry = mk.plugins && mk.plugins[0];
  if (!entry) errs.push('marketplace.json 缺 plugins[0]');
  else {
    if (entry.version !== pj.version) errs.push('版本不一致: marketplace=' + entry.version + ' plugin=' + pj.version);
    if (entry.name !== pj.name) errs.push('插件名不一致: marketplace=' + entry.name + ' plugin=' + pj.name);
    // 官方规则：plugin.json 的 description_i18n 必须与市场条目完全相等
    try { assert.deepStrictEqual(entry.description_i18n, pj.description_i18n); }
    catch (e) { errs.push('description_i18n 不一致: marketplace 与 plugin.json 必须完全相等'); }
    const categories = ['developer-tools', 'productivity', 'utilities', 'guides', 'finance', 'template', 'other'];
    if (categories.indexOf(entry.category) < 0) errs.push('category 不在官方白名单: ' + entry.category);
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(pj.name)) errs.push('插件名不符合官方清单正则: ' + pj.name);
  if (!pj.description) errs.push('plugin.json 缺 description');
  if (!i18nOK(pj.description_i18n)) errs.push('plugin.json description_i18n 缺 en/zh-CN 非空项');
  if (!pj.userConfig || !pj.userConfig.custom_rules) errs.push('plugin.json 缺 userConfig.custom_rules');

  const hj = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'zcode-fence', 'hooks', 'hooks.json'), 'utf8'));
  const groups = hj.hooks && hj.hooks.PreToolUse;
  if (!groups || !groups.length) errs.push('hooks.json 缺 PreToolUse');
  else {
    const g = groups[0];
    const h = g.hooks && g.hooks[0];
    if (g.matcher !== 'Bash|Write|Edit|ApplyPatch') errs.push('matcher 不符: ' + g.matcher);
    if (!h || h.type !== 'process' || h.command !== 'node') errs.push('hook type/command 不符');
    if (!h || !h.args || !h.args.some((a) => String(a).indexOf('${ZCODE_PLUGIN_ROOT}/scripts/guard.js') >= 0)) errs.push('hook args 未指向 guard.js');
    if (!h || typeof h.timeoutMs !== 'number') errs.push('缺 timeoutMs');
  }
  return errs;
}

/* ---------- 主流程 ---------- */

(async function main() {
  setup();
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));

  let pass = 0, fail = 0, skip = 0;
  const allStdout = [];
  const failed = [];

  for (const c of cases) {
    let r;
    try {
      r = await runCase(c);
      if (r.skipped) { skip++; console.log('  --   ' + c.id + '（平台不适用，跳过）'); continue; }
      assertResult(c, r.res);
      allStdout.push(r.res.out);
      pass++;
      console.log('  ok   ' + c.id + '  ' + c.desc);
    } catch (e) {
      fail++;
      failed.push(c.id);
      console.error('  FAIL ' + c.id + '  ' + c.desc + '\n        ' + (e && e.message));
      if (r && !r.skipped && r.res) allStdout.push(r.res.out);
    }
  }

  // 全局不变量：永不 allow / deny
  for (const out of allStdout) {
    assert.ok(!/"permissionDecision"\s*:\s*"(allow|deny)"/.test(out),
      '全局不变量被破坏：出现了 allow/deny 决策');
  }

  // 决策日志：fail-open 的异常必须留痕（RB-01），ask 也应记录
  const logFile = path.join(LOGS, 'decisions.log');
  const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (logText.indexOf('"level":"error"') < 0 || logText.indexOf('非法 JSON') < 0) {
    fail++; failed.push('LOG-ERROR-TRACE');
    console.error('  FAIL LOG-ERROR-TRACE  fail-open 异常未写入决策日志');
  }
  if (logText.indexOf('"verdict":"ask"') < 0) {
    fail++; failed.push('LOG-ASK-TRACE');
    console.error('  FAIL LOG-ASK-TRACE  ask 判定未写入决策日志');
  }

  const staticErrs = staticChecks();
  for (const e of staticErrs) { fail++; failed.push('STATIC'); console.error('  FAIL STATIC  ' + e); }

  console.log('');
  console.log('验收用例：' + pass + ' 通过，' + fail + ' 失败，' + skip + ' 跳过（平台不适用）');
  if (fail) { console.log('失败用例：' + failed.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('runner 崩溃：', e); process.exit(1); });
