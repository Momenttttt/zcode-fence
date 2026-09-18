'use strict';

/*
 * zcode-fence 单元测试 —— 纯函数层（normalizePath / 切分 / 提取 / 判定 / 配置）
 * 运行：node tests/unit.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../plugins/zcode-fence/scripts/guard.js');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.error('  FAIL ' + name + '\n      ' + (e && e.message)); }
}

const WIN_ENV = {
  USERPROFILE: 'C:\\Users\\u',
  TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\u\\AppData\\Local\\Temp',
  SystemRoot: 'C:\\Windows',
};
const NIX_ENV = { HOME: '/home/u', TMPDIR: '/tmp' };

const win = (s, msysAlways) => guard.normalizePath(s, { platform: 'win32', env: WIN_ENV, msysAlways: !!msysAlways });
const nix = (s, msysAlways) => guard.normalizePath(s, { platform: 'linux', env: NIX_ENV, msysAlways: !!msysAlways });

console.log('== normalizePath（Windows 语义）==');
t('盘符反斜杠', () => assert.strictEqual(win('C:\\Users\\x').norm, 'C:\\Users\\x'));
t('盘符正斜杠统一', () => assert.strictEqual(win('C:/Users/x').norm, 'C:\\Users\\x'));
t('MSYS /c/... 映射（msysAlways）', () => assert.strictEqual(win('/c/Users/x', true).norm, 'C:\\Users\\x'));
t('MSYS 裸 /c 映射为盘根', () => assert.strictEqual(win('/c', true).norm, 'C:\\'));
t('~ 展开', () => assert.strictEqual(win('~/Desktop').norm, 'C:\\Users\\u\\Desktop'));
t('%USERPROFILE% 展开', () => assert.strictEqual(win('%USERPROFILE%\\Desktop').norm, 'C:\\Users\\u\\Desktop'));
t('%TEMP% 展开', () => assert.strictEqual(win('%TEMP%\\f').norm, 'C:\\Users\\u\\AppData\\Local\\Temp\\f'));
t('/tmp 按 MSYS 语义映射到真实 TEMP', () => assert.strictEqual(win('/tmp/f').norm, 'C:\\Users\\u\\AppData\\Local\\Temp\\f'));
t('/dev/null → NUL', () => { const i = win('/dev/null'); assert.strictEqual(i.kind, 'null'); assert.strictEqual(i.norm, 'NUL'); });
t('盘根 D:/ 与裸盘符 D:', () => {
  assert.strictEqual(win('D:/').norm, 'D:\\');
  assert.strictEqual(win('D:').norm, 'D:');
});
t('.. 词法消解 + 尾分隔符剥离', () => assert.strictEqual(win('C:\\a\\..\\b\\').norm, 'C:\\b'));
t('大小写盘符统一', () => assert.strictEqual(win('e:/x').norm, 'E:\\x'));
t('UNC \\\\server\\share', () => { const i = win('\\\\server\\share\\x'); assert.strictEqual(i.kind, 'unc'); assert.strictEqual(i.norm, '\\\\server\\share\\x'); });
t('未定义 %VAR% → unresolved', () => assert.strictEqual(win('%NOPE%\\x').unresolved, true));
t('多值变量展开（含分号）→ unresolved', () => {
  const i2 = guard.normalizePath('$MAGIC/x', { platform: 'linux', env: { MAGIC: 'a;b' } });
  assert.strictEqual(i2.kind, 'unresolved');
});
t('未定义 $VAR 按 shell 语义空展开 → /x 落入 MSYS 单字母盘根（保守方向）', () => {
  assert.strictEqual(win('$NOPE/x', true).norm, 'X:\\');
});
t('相对路径保持相对', () => { const i = win('node_modules'); assert.strictEqual(i.kind, 'relative'); });
t('./src 不被当成绝对路径', () => { const i = win('./src'); assert.strictEqual(i.kind, 'relative'); });

console.log('== normalizePath（Unix 语义）==');
t('/tmp/f 原生', () => { const i = nix('/tmp/f'); assert.strictEqual(i.kind, 'unix'); assert.strictEqual(i.norm, '/tmp/f'); });
t('$HOME/proj 展开', () => assert.strictEqual(nix('$HOME/proj').norm, '/home/u/proj'));
t('~ 展开', () => assert.strictEqual(nix('~/x').norm, '/home/u/x'));
t('/c/Users 在 Linux 上也按 MSYS 映射（msysAlways，危险形状是文本事实）', () => assert.strictEqual(nix('/c/Users/x', true).norm, 'C:\\Users\\x'));
t('Windows 形态路径在 Linux 语义下也识别为盘符路径', () => { const i = nix('C:\\x'); assert.strictEqual(i.kind, 'drive'); assert.strictEqual(i.norm, 'C:\\x'); });
t('/dev/null（Unix）', () => { const i = nix('/dev/null'); assert.strictEqual(i.norm, '/dev/null'); });

console.log('== 命令切分 / 分词 ==');
t('按 && || ; | & 换行切分', () =>
  assert.deepStrictEqual(guard.splitSegments('a && b || c; d | e\nf & g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']));
t('引号内的分隔符不切分', () => assert.deepStrictEqual(guard.splitSegments('echo "a && b"'), ['echo "a && b"']));
t('分词并剥引号', () => assert.deepStrictEqual(guard.tokenize('rm -rf "C:/Users"'), ['rm', '-rf', 'C:/Users']));
t('命令首词：sudo/VAR=/路径/扩展名剥除', () => {
  assert.strictEqual(guard.parseCmd(['sudo', 'rm', '-rf', '/']).name, 'rm');
  assert.strictEqual(guard.parseCmd(['CC=x', 'make']).name, 'make');
  assert.strictEqual(guard.parseCmd(['/usr/bin/rm', '-rf', '/']).name, 'rm');
  assert.strictEqual(guard.parseCmd(['C:\\Windows\\System32\\del.exe', '/s']).name, 'del');
  assert.strictEqual(guard.parseCmd(['(cd', '/x']).name, 'cd');
});

console.log('== 路径 token / 重定向提取 ==');
t('引号内的盘符路径可提取', () =>
  assert.ok(guard.extractPathTokens('echo x > "C:/Users/alice/Desktop/pwn.txt"').includes('C:/Users/alice/Desktop/pwn.txt')));
t('URL 不产生伪 token', () =>
  assert.deepStrictEqual(guard.extractPathTokens('curl -sSf https://example.com/a/b -o out'), []));
t('MSYS/波浪线/变量混合提取', () => {
  const toks = guard.extractPathTokens('rm -rf /c/Users ~ %TEMP%/x $HOME/y');
  assert.ok(toks.includes('/c/Users'));
  assert.ok(toks.includes('~'));
  assert.ok(toks.includes('%TEMP%/x'));
  assert.ok(toks.includes('$HOME/y'));
});
t('相对路径与 ./ 不提取', () =>
  assert.deepStrictEqual(guard.extractPathTokens('rm -rf node_modules ./src'), []));
t('重定向目标：带引号/2>&1', () => {
  assert.deepStrictEqual(guard.extractRedirects('echo x > "C:/Users/a b/f.txt"'), ['C:/Users/a b/f.txt']);
  assert.deepStrictEqual(guard.extractRedirects('ls > /dev/null 2>&1'), ['/dev/null']);
  assert.deepStrictEqual(guard.extractRedirects('cmd 2>> err.log'), ['err.log']);
});

console.log('== 灾难级目标判定 ==');
const winCtx = { platform: 'win32', homeNorm: 'C:\\Users\\u' };
const nixCtx = { platform: 'linux', homeNorm: '/home/u' };
const dg = (s, ctx) => guard.isDangerTarget(guard.normalizePath(s, { platform: ctx.platform, env: ctx.platform === 'win32' ? WIN_ENV : NIX_ENV, msysAlways: true }), ctx);
t('win：盘根/Users/Users直系/系统目录', () => {
  assert.strictEqual(dg('C:\\', winCtx), true);
  assert.strictEqual(dg('C:/Users', winCtx), true);
  assert.strictEqual(dg('C:\\Users\\victim', winCtx), true);
  assert.strictEqual(dg('C:\\Users\\u\\proj', winCtx), false);
  assert.strictEqual(dg('C:\\Windows', winCtx), true);
  assert.strictEqual(dg('C:\\ProgramData', winCtx), true);
  assert.strictEqual(dg('D:/', winCtx), true);
  assert.strictEqual(dg('/c/Users', winCtx), true);
  assert.strictEqual(dg('~', winCtx), true);
  assert.strictEqual(dg('~/*', winCtx), true);
});
t('unix：根/home/系统目录', () => {
  assert.strictEqual(dg('/', nixCtx), true);
  assert.strictEqual(dg('/home/u', nixCtx), true);
  assert.strictEqual(dg('/home/x', nixCtx), true);
  assert.strictEqual(dg('/home/x/y', nixCtx), false);
  assert.strictEqual(dg('/etc', nixCtx), true);
  assert.strictEqual(dg('/Users/x', nixCtx), true);
  assert.strictEqual(dg('/usr', nixCtx), true);
});

console.log('== 包含关系 / 大小写策略 ==');
t('win/darwin 大小写不敏感', () => assert.strictEqual(guard.isUnder('c:\\users\\u\\p', 'C:\\Users\\u', 'win32'), true));
t('linux 大小写敏感', () => assert.strictEqual(guard.isUnder('/Home/u/p', '/home/u', 'linux'), false));
t('前缀必须是目录边界', () => {
  assert.strictEqual(guard.isUnder('/home/user2/x', '/home/user', 'linux'), false);
  assert.strictEqual(guard.isUnder('/home/user/x', '/home/user', 'linux'), true);
});

console.log('== 配置读取 ==');
const cfgTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-fence-cfg-'));
const cfgFile = path.join(cfgTmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  plugins: { options: { 'zcode-fence@zcode-fence-market': { enable_danger_gate: 'false', custom_rules: 'foo;bar' } } },
}));
const loaded = guard.loadConfig({ ZCODE_FENCE_CONFIG: cfgFile });
t('布尔字符串与分号清单', () => {
  assert.strictEqual(loaded.cfg.enable_danger_gate, false);
  assert.deepStrictEqual(guard.splitList(loaded.cfg.custom_rules), ['foo', 'bar']);
});
fs.writeFileSync(cfgFile, '{ broken json');
t('坏配置 → 默认值 + 留痕', () => {
  const r = guard.loadConfig({ ZCODE_FENCE_CONFIG: cfgFile });
  assert.strictEqual(r.cfg.enable_danger_gate, true);
  assert.ok(r.notes.length > 0);
});
t('清单切分容忍空段', () => assert.deepStrictEqual(guard.splitList('a;; b '), ['a', 'b']));

console.log('== 符号链接逃逸（realpath 防护，创建失败则跳过）==');
const fsTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-fence-fs-'));
const realRoot = path.join(fsTmp, 'root');
const outside = path.join(fsTmp, 'outside');
fs.mkdirSync(realRoot); fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
let link;
try {
  link = path.join(realRoot, 'evil');
  fs.symlinkSync(outside, link, 'dir');
} catch (e) { link = null; }
if (link) {
  t('词法在界内但 realpath 指向界外 → 判界外', () => {
    const target = path.join(link, 'f.txt');
    assert.strictEqual(guard.isInsideRoots(target, [realRoot], process.platform), false);
  });
  t('界内真实路径 → 界内', () => {
    const target = path.join(realRoot, 'a', 'b', 'c.txt'); // 不存在，逐级上溯
    assert.strictEqual(guard.isInsideRoots(target, [realRoot], process.platform), true);
  });
} else {
  console.log('  (跳过) 当前环境无法创建符号链接');
}

console.log('== 判定层冒烟（judgePayload）==');
const projDir = path.join(fsTmp, 'proj');
fs.mkdirSync(path.join(projDir, 'src'), { recursive: true });
const smokeEnv = {
  ZCODE_PROJECT_DIR: projDir,
  ZCODE_FENCE_CONFIG: cfgFile.replace(/config\.json$/, 'empty.json'),
  ZCODE_FENCE_DATA_DIR: path.join(fsTmp, 'logs'),
  TEMP: process.env.TEMP, TMP: process.env.TMP,
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
};
fs.writeFileSync(path.join(cfgTmp, 'empty.json'), '{"plugins":{"options":{}}}');
t('rm -rf / → ask（危险门）', () => {
  const r = guard.judgePayload({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, smokeEnv);
  assert.ok(r.reasons.some((x) => x.indexOf('危险命令') >= 0));
});
t('echo 越界重定向 → ask（围栏）', () => {
  const r = guard.judgePayload({ tool_name: 'Bash', tool_input: { command: 'echo x > C:/Users/outside/pwn.txt' } }, smokeEnv);
  assert.ok(r.reasons.some((x) => x.indexOf('越界写入') >= 0));
});
t('项目内写 → silent', () => {
  const r = guard.judgePayload({ tool_name: 'Write', tool_input: { file_path: path.join(projDir, 'src', 'a.ts') } }, smokeEnv);
  assert.strictEqual(r.reasons.length, 0);
});

console.log('');
console.log('单元测试：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
