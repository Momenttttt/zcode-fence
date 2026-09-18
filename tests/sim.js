'use strict';

/*
 * zcode-fence 跨平台语义模拟器（可选开发工具，不计入 npm test / CI）
 *
 * 在任意主机上以 Linux/macOS 语义（posix path + 恒等 realpath + 对应 platform）
 * 进程内跑完 tests/cases.json 全部用例，用于在 Windows 开发机上提前暴露
 * 非 Windows 平台的判定翻转（CI 三平台矩阵是最终权威；本工具为 advisory）。
 *
 * 已知保真度限制：realpath 取恒等（不解析符号链接）、无真实目录存在性，
 * 涉及符号链接/真实目录差异的场景以 CI 为准。
 *
 * 用法：node tests/sim.js [linux|darwin]
 */

const P = require('path');
const posix = P.posix;
const origJoin = P.join.bind(P);
const SIM_PLATFORM = process.argv[2] || 'linux';

// guard.js 对 process.platform / path.* / fs.realpathSync 的读取都发生在调用时，
// 因此先加载模块、后打补丁即可（顺序不能反：patch path.resolve 会破坏 Node 的 require 解析）。
const guard = require('../plugins/zcode-fence/scripts/guard.js');

// 打补丁前先取真实的系统临时目录（补丁后 os.tmpdir 会返回假路径）
const fs = require('fs');
const os = require('os');
const REAL_TMP = os.tmpdir();

P.join = posix.join; P.dirname = posix.dirname; P.basename = posix.basename; P.resolve = posix.resolve;
P.sep = '/'; P.delimiter = ':';
fs.realpathSync = function (p) { return String(p); }; // 恒等 realpath
os.tmpdir = function () { return '/tmp'; };
Object.defineProperty(process, 'platform', { value: SIM_PLATFORM });

const cases = JSON.parse(fs.readFileSync(origJoin(__dirname, 'cases.json'), 'utf8'));

// 夹具配置写入真实系统临时目录（内容为 linux 路径版；判定是纯逻辑，无需真实目录）
const HOME = SIM_PLATFORM === 'darwin' ? '/Users/runner' : '/home/runner';
const WORK = SIM_PLATFORM === 'darwin' ? '/Users/runner/work' : '/home/runner/work';
const PROJECT = WORK + '/zcode-fence/zcode-fence';
const EXTRA = WORK + '/extra-root';
const MEM = HOME + '/.zcode/cli/memories';
const CFGDIR = origJoin(REAL_TMP, 'zcode-fence-sim-' + SIM_PLATFORM);
fs.rmSync(CFGDIR, { recursive: true, force: true });
fs.mkdirSync(CFGDIR, { recursive: true });
const opt = (v) => ({ plugins: { options: { 'zcode-fence@zcode-fence-market': v } } });
const fixtures = {
  'default.json': opt({}),
  'custom.json': opt({ custom_rules: '^special-cleanup' }),
  'invalid.json': opt({ custom_rules: 'special-cleanup;([' }),
  'gate-off.json': opt({ enable_danger_gate: 'false' }),
  'fence-off.json': opt({ enable_fence: 'false' }),
  'extra-roots.json': opt({ extra_writable_roots: EXTRA }),
};
for (const [n, v] of Object.entries(fixtures)) fs.writeFileSync(origJoin(CFGDIR, n), JSON.stringify(v));

const render = (s) => String(s)
  .replace(/\{PROJECT\}/g, PROJECT)
  .replace(/\{EXTRA\}/g, EXTRA)
  .replace(/\{MEM\}/g, MEM)
  .replace(/\{TEMP\}/g, '/tmp')
  .replace(/\{LONG\}/g, 'a'.repeat(10000));

let bad = 0;
for (const c of cases) {
  if (c.platforms && c.platforms.indexOf(SIM_PLATFORM) < 0) continue;
  const env = {
    HOME,
    TMPDIR: '/tmp',
    ZCODE_FENCE_CONFIG: CFGDIR.replace(/\\/g, '/') + '/' + (c.config || 'default') + '.json',
  };
  if (!c.noProject) env.ZCODE_PROJECT_DIR = PROJECT;

  let verdict;
  let reasons = [];
  if (c.mode === 'stdin-raw') {
    const r = guard.runGuard(c.stdin, env, 'sim');
    verdict = r.record.verdict === 'ask' ? 'ask' : 'silent';
    reasons = r.record.reasons || [];
  } else {
    let payload;
    if (c.mode === 'bash') payload = { tool_name: 'Bash', tool_input: { command: render(c.command) } };
    else if (c.mode === 'file') payload = { tool_name: c.tool || 'Write', tool_input: { file_path: render(c.file_path) } };
    else {
      const ti = {};
      if (c.command != null) ti.command = render(c.command);
      if (c.path != null) ti.path = render(c.path);
      if (c.query != null) ti.query = c.query;
      payload = { tool_name: c.tool, tool_input: ti };
    }
    const r = guard.judgePayload(payload, env);
    verdict = r.reasons.length ? 'ask' : 'silent';
    reasons = r.reasons;
  }
  if (verdict !== c.expect) {
    bad++;
    console.log('MISMATCH ' + c.id + '  ' + c.desc);
    console.log('   expect=' + c.expect + '  got=' + verdict);
    reasons.forEach((x) => console.log('   reason: ' + x));
  }
}
console.log('(' + SIM_PLATFORM + ') 模拟完成：' + (bad ? bad + ' 条不符' : '全部符合期望'));
process.exit(bad ? 1 : 0);
