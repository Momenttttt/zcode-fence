#!/usr/bin/env node
'use strict';

/*
 * zcode-fence —— ZCode 确定性围栏插件（危险命令门 + 项目围栏）
 *
 * 设计原则：
 *  - 纯规则匹配：同一条命令永远得到同一判定，无 AI 判断、无网络请求、零 npm 依赖（Node >= 16）。
 *  - 零误报哲学：项目内日常操作一律放行；只拦「灾难级命令」和「写到项目之外」两件事。
 *  - ask-only：永不输出 allow/deny。命中违规输出 ask（弹确认），其余无输出 exit 0，
 *    交还宿主按其自身权限模式处理 —— 插件只加锁，不改锁。
 *  - fail-open：stdin 解析失败或内部异常时放行（exit 0 无输出），异常写入决策日志留痕。
 *
 * 判定协议遵循 ZCode 宿主 PreToolUse hook 的 hookSpecificOutput schema（严格校验，多余 key 宿主拒收）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const PLUGIN_ID = 'zcode-fence';
const MAX_DEPTH = 3; // 包装器（cmd /c、bash -c、powershell -Command）递归深度上限

/* ================================================================
 * 基础工具与配置
 * ================================================================ */

function homeOf(env) {
  return env.ZCODE_FENCE_HOME || env.HOME || env.USERPROFILE || os.homedir();
}

function truthy(v, dflt) {
  if (v === true || v === 1 || v === 'true' || v === '1') return true;
  if (v === false || v === 0 || v === 'false' || v === '0') return false;
  return dflt;
}

// 设置界面是单行输入框会剥换行 → 所有清单类配置用分号分隔；正则段内不能出现分号
function splitList(s) {
  return String(s == null ? '' : s).split(';').map((t) => t.trim()).filter(Boolean);
}

const DEFAULT_CONFIG = {
  enable_danger_gate: true,
  enable_fence: true,
  custom_rules: '',
  extra_writable_roots: '',
  enable_log: true,
};

// 每次工具调用现读 ~/.zcode/cli/config.json，改完即生效
function loadConfig(env) {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  const notes = [];
  const cfgPath = env.ZCODE_FENCE_CONFIG ||
    path.join(homeOf(env), '.zcode', 'cli', 'config.json');
  let raw = null;
  try { raw = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { /* 无配置文件 → 默认值 */ }
  if (raw != null) {
    try {
      const obj = JSON.parse(raw);
      const options = (obj && obj.plugins && obj.plugins.options) || {};
      // 配置键形如 zcode-fence@<市场名>（本地市场/官方市场名不同），兼容裸 zcode-fence
      const keys = Object.keys(options)
        .filter((k) => k === PLUGIN_ID || k.indexOf(PLUGIN_ID + '@') === 0)
        .sort();
      if (!keys.length) {
        notes.push('config 无 ' + PLUGIN_ID + ' 配置项，使用默认值');
      } else {
        if (keys.length > 1) notes.push('config 命中多个键，使用 ' + keys[0]);
        const user = options[keys[0]];
        if (user && typeof user === 'object') {
          cfg.enable_danger_gate = truthy(user.enable_danger_gate, true);
          cfg.enable_fence = truthy(user.enable_fence, true);
          cfg.custom_rules = typeof user.custom_rules === 'string' ? user.custom_rules : '';
          cfg.extra_writable_roots = typeof user.extra_writable_roots === 'string' ? user.extra_writable_roots : '';
          cfg.enable_log = truthy(user.enable_log, true);
        }
      }
    } catch (e) {
      notes.push('config 解析失败(' + e.message + ')，使用默认值');
    }
  }
  return { cfg, cfgPath, notes };
}

/* ================================================================
 * 路径归一化 —— 全项目地基
 *
 * 处理：~ / $HOME / $VAR / ${VAR} / %VAR% 展开、MSYS /c/... 映射、
 * /tmp（Windows 语境 → %TEMP%）、/dev/null（→ NUL）、正反斜杠统一、
 * 盘符大小写、. 与 .. 的词法消解。
 * ================================================================ */

function expandVars(s, env) {
  let unresolved = false;
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, n) => ((n in env) && env[n] != null ? env[n] : ''));
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, n) => ((n in env) && env[n] != null ? env[n] : ''));
  // cmd 风格 %VAR%：未定义时 cmd 保持字面量 → 标记为无法解析
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_()]*)%/g, (m, n) => {
    if ((n in env) && env[n] != null) return env[n];
    unresolved = true;
    return m;
  });
  return { s, unresolved };
}

function resolveParts(parts) {
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') { out.pop(); continue; }
    out.push(p);
  }
  return out;
}

function winJoin(drive, rest) {
  const parts = resolveParts(String(rest == null ? '' : rest).split(/[\\\/]+/));
  return parts.length ? drive + '\\' + parts.join('\\') : drive + '\\';
}

/**
 * 归一化单个路径。
 * 返回 { kind, norm, raw, unresolved }
 *   kind: 'drive' | 'unc' | 'unix' | 'null' | 'relative' | 'empty' | 'unresolved'
 * opts: { platform, env, msysAlways }
 *   msysAlways: Bash 命令 token 判定用 —— /c/Users 这类 Git Bash 风格在任何平台
 *   都按 MSYS 语义映射（危险形状是文本事实，与宿主 OS 无关）；文件工具路径仅
 *   Windows 主机上映射（msysAlways=false）。
 */
function normalizePath(input, opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const msysAlways = !!opts.msysAlways;
  const raw = input;
  let s = String(input == null ? '' : input).trim();
  if (!s) return { kind: 'empty', norm: '', raw };

  if (s === '~' || s.slice(0, 2) === '~/' || s.slice(0, 2) === '~\\') {
    s = homeOf(env) + s.slice(1);
  }
  const ex = expandVars(s, env);
  s = ex.s;
  const unresolved = ex.unresolved;
  if (!s) return { kind: 'empty', norm: '', raw, unresolved };

  // 展开结果里混入分号/换行（多半是 $PATH 这类多值变量）→ 无法解析
  if (/[\r\n;]/.test(s)) return { kind: 'unresolved', norm: '', raw, unresolved: true };

  // UNC：\\server\share 或 //server/share
  if (/^\\\\[^\\]/.test(s) || /^\/\/[^/]/.test(s)) {
    return { kind: 'unc', norm: s.replace(/\//g, '\\'), raw };
  }

  let m = /^([A-Za-z]):[\\/](.*)$/.exec(s);
  if (m) return { kind: 'drive', norm: winJoin(m[1].toUpperCase() + ':', m[2]), raw, unresolved };
  if (/^[A-Za-z]:$/.test(s)) return { kind: 'drive', norm: s.toUpperCase(), raw };

  // MSYS 单字母根 /c/...（或裸 /c）
  m = /^\/([A-Za-z])(\/.*)?$/.exec(s);
  if (m && (msysAlways || platform === 'win32')) {
    return normalizePath(m[1].toUpperCase() + ':\\' + (m[2] || ''), opts);
  }

  // Windows 语境：/tmp 按 MSYS 语义近似映射到真实临时目录
  if (platform === 'win32' && (s === '/tmp' || s.slice(0, 5) === '/tmp/')) {
    const t = env.TEMP || env.TMP || os.tmpdir();
    return normalizePath(t + s.slice(4), opts);
  }
  if (s === '/dev/null' || s.slice(0, 10) === '/dev/null/') {
    return { kind: 'null', norm: platform === 'win32' ? 'NUL' : '/dev/null', raw };
  }

  if (s[0] === '/') {
    const parts = resolveParts(s.split(/[\/]+/));
    return { kind: 'unix', norm: parts.length ? '/' + parts.join('/') : '/', raw, unresolved };
  }

  // 其余（含盘符相对 X:foo）按相对路径处理，由调用方决定解析基准
  return { kind: 'relative', norm: s, raw, unresolved };
}

/* ================================================================
 * realpath（防符号链接偷渡：逐级上溯找最深存在的祖先再 realpath）
 * ================================================================ */

const realCache = new Map();

function realPathBest(p, platform) {
  if (!p) return null;
  if (platform !== process.platform) return null; // 仅本机平台可查 fs，跨平台走词法比较
  if (realCache.has(p)) return realCache.get(p);
  let result = null;
  let cur = p;
  const suffix = [];
  for (let i = 0; i < 128; i++) {
    let rp = null;
    try { rp = fs.realpathSync(cur); } catch (e) { rp = null; }
    if (rp != null) { result = suffix.length ? path.join(rp, ...suffix) : rp; break; }
    const parent = path.dirname(cur);
    if (parent === cur) { result = cur; break; }
    suffix.unshift(path.basename(cur));
    cur = parent;
  }
  if (result != null && path.sep === '\\') result = result.replace(/\//g, '\\');
  realCache.set(p, result);
  return result;
}

/* ================================================================
 * 包含关系判定（Windows/macOS 大小写不敏感，Linux 敏感）
 * ================================================================ */

function isUnder(child, parent, platform) {
  const ci = platform === 'win32' || platform === 'darwin';
  const sep = parent.indexOf('\\') >= 0 ? '\\' : '/';
  const pre = parent.slice(-1) === sep ? parent : parent + sep;
  if (ci) {
    const lc = child.toLowerCase();
    const lp = parent.toLowerCase();
    if (lc === lp) return true;
    return lc.startsWith(pre.toLowerCase());
  }
  if (child === parent) return true;
  return child.startsWith(pre);
}

// 优先用 realpath 双边比较（符号链接逃逸在此被抓住）；任一侧无法 realpath 时退回词法比较
function isInsideRoots(norm, roots, platform) {
  for (const root of roots) {
    const tr = realPathBest(norm, platform);
    const rr = realPathBest(root, platform);
    if (tr && rr) {
      if (isUnder(tr, rr, platform)) return true;
      continue;
    }
    if (isUnder(norm, root, platform)) return true;
  }
  return false;
}

/* ================================================================
 * 灾难级目标判定（危险命令门专用）
 * ================================================================ */

const SYS_DIRS_UNIX = ['/etc', '/usr', '/var', '/bin', '/sbin', '/lib', '/lib64', '/libx32',
  '/boot', '/dev', '/opt', '/sys', '/System', '/Library', '/Applications', '/Users', '/home'];
const SYS_DIRS_WIN = ['windows', 'program files', 'program files (x86)', 'programdata', 'users', 'perflogs'];

function isDangerTarget(info, ctx) {
  if (!info) return false;
  if (info.kind === 'null' || info.kind === 'relative' || info.kind === 'empty' ||
      info.kind === 'unresolved' || info.kind === 'unc') return false;
  let t = info.norm.replace(/[\*\s]+$/, '').replace(/[\/\\]+$/, '');
  const ci = ctx.platform === 'win32' || ctx.platform === 'darwin';
  const eq = (a, b) => (ci ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
  const home = ctx.homeNorm || '';

  if (info.kind === 'unix') {
    if (!t) t = '/';
    if (t === '/') return true;
    if (home && eq(t, home)) return true;
    if (SYS_DIRS_UNIX.indexOf(t) >= 0) return true;
    if (/^\/(home|Users)\/[^\/]+$/.test(t)) return true; // 某人的整个 home 目录
    return false;
  }
  // drive
  if (/^[A-Za-z]:$/.test(t)) return true; // 盘符根 C:
  if (home && eq(t, home)) return true;
  const mm = /^([A-Za-z]):\\(.*)$/.exec(t);
  if (!mm) return false;
  const rel = mm[2].toLowerCase();
  if (SYS_DIRS_WIN.indexOf(rel) >= 0) return true;
  if (rel.indexOf('users\\') === 0) {
    const rest = rel.slice(6);
    if (!rest) return true;               // C:\Users
    return rest.indexOf('\\') < 0;        // C:\Users\<user>（直系，即某个用户的整个 home）
  }
  return false;
}

/* ================================================================
 * 命令切分 / 分词 / 路径 token 提取
 * ================================================================ */

// 按 &&、||、;、|、单个 &、换行切分（引号感知；\x 转义感知）
function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let quote = null;
  const s = String(cmd == null ? '' : cmd);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '\\') { cur += ch + (s[i + 1] || ''); i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur);
  return segs.map((t) => t.trim()).filter(Boolean);
}

// 空白分词，剥除引号（引号内的路径 token 也要能提取 —— 修复引号穿透）
function tokenize(seg) {
  const toks = [];
  let cur = '';
  let quote = null;
  const s = String(seg == null ? '' : seg);
  const push = () => { if (cur !== '') { toks.push(cur); cur = ''; } };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { cur += ch + s[i + 1]; i++; continue; }
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { push(); continue; }
    cur += ch;
  }
  push();
  return toks;
}

// 路径 token 提取（引号内的目标同样被覆盖：提取在剥引号后的整段文本上进行）
const TOKEN_RES = [
  /(?<![A-Za-z0-9$%@.\\/-])[A-Za-z]:[\\/][^\s'"<>|;&()]*/g,               // C:\... C:/...（排除 URL 伪命中）
  /(?<![\w:\\/.%$@-])(?:\\\\|\/\/)[^\s'"<>|;&()]+/g,                       // \\server\share、//server/share（排除 URL 的 //）
  /(?<![\w:~$%@.\\/-])\/[^\s'"<>|;&()]*/g,                                 // /abs（含 /c/、/tmp、裸 /）
  /(?<![\w\\/@%$.-])~(?![A-Za-z0-9_-])(?:[\\/][^\s'"<>|;&()]*)?/g,        // ~、~/x（~user 不误吃）
  /(?<![\w\\/@%.$-])\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[\\/][^\s'"<>|;&()]*/g, // $VAR/x、${VAR}/x
  /(?<![\w\\/@$.-])%[A-Za-z_][A-Za-z0-9_()]*%[\\/]?[^\s'"<>|;&()]*/g,     // %VAR%\x、%VAR%/x
];

function extractPathTokens(text) {
  const seen = new Set();
  const out = [];
  const s = String(text == null ? '' : text);
  for (const re of TOKEN_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      // 裸 /x 单字母形态在 Windows 命令行里几乎总是开关（/s /q /w …），MSYS 裸盘根过于罕见 → 跳过（零误报优先）
      if (/^\/[A-Za-z]$/.test(m[0])) continue;
      if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
    }
  }
  return out;
}

// 重定向目标提取：> >> 2> 2>> &> &>> 2>&1（目标为 &N 时天然不匹配路径形态）
const RE_REDIRECT = /(?:^|[\s(])(?:\d*&?)>{1,2}\s*("([^"]*)"|'([^']*)'|([^\s<>|;&)]+))/g;

function extractRedirects(seg) {
  const out = [];
  RE_REDIRECT.lastIndex = 0;
  let m;
  const s = String(seg == null ? '' : seg);
  while ((m = RE_REDIRECT.exec(s)) !== null) {
    const t = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    if (t != null && t !== '') out.push(t);
  }
  return out;
}

/* ================================================================
 * 命令首词解析（token 级精确匹配的地基：echo "rm -rf /" 不误伤）
 * ================================================================ */

const PREFIX_CMDS = new Set(['sudo', 'env', 'nohup', 'nice', 'time', 'command', 'exec', 'strace', 'valgrind']);

function parseCmd(tokens) {
  let i = 0;
  while (i < tokens.length) {
    let t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // VAR=val 前缀
    while (t[0] === '(') t = t.slice(1);                        // 子 shell 残留
    if (!t) { i++; continue; }
    let base = t;
    const slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
    if (slash >= 0) base = base.slice(slash + 1);
    base = base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
    if (PREFIX_CMDS.has(base)) { i++; continue; }
    return { name: base, args: tokens.slice(i + 1) };
  }
  return null;
}

/* ================================================================
 * 危险命令门（宁可漏报不可误报：只收灾难级）
 * ================================================================ */

const RE_FORK = /:\s*\(\)\s*\{[^}]*[|&][^}]*[|&][^}]*\}\s*;?\s*:/;

const WIN_DEL_CMDS = new Set(['del', 'rd', 'rmdir', 'erase']);
const PS_REMOVE = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd']);
const PS_DISK_KILLER = new Set(['format-volume', 'clear-disk', 'remove-partition', 'initialize-disk', 'reset-physicaldisk']);
const REG_HIVES = {
  hklm: 1, hkcu: 1, hkcr: 1, hku: 1, hkcc: 1,
  hkey_local_machine: 1, hkey_current_user: 1, hkey_classes_root: 1, hkey_users: 1, hkey_current_config: 1,
};

function recursiveFlag(args) {
  for (const t of args) {
    if (t.indexOf('--') === 0) { if (/recursive/i.test(t)) return true; continue; }
    if (t.length > 1 && t[0] === '-' && /[rR]/.test(t.slice(1))) return true; // -r -rf -fr -Recurse
  }
  return false;
}

function dangerTargetsOf(seg, ctx) {
  return extractPathTokens(seg)
    .map((t) => normalizePath(t, ctx.npBash))
    .filter((info) => isDangerTarget(info, ctx))
    .map((info) => info.norm);
}

function gateReason(add, label, rule) {
  add('[' + PLUGIN_ID + ': 危险命令] ' + label + '（规则 ' + rule + '）');
}

function gateSegment(seg, ctx, depth, add) {
  if (depth > MAX_DEPTH) return;
  const tokens = tokenize(seg);
  const pc = parseCmd(tokens);
  if (!pc) return;
  const name = pc.name;
  const args = pc.args;
  const rest = args.join(' ');

  if (name === 'rm') {
    if (args.indexOf('--no-preserve-root') >= 0) {
      if (extractPathTokens(seg).length) {
        gateReason(add, 'rm 使用 --no-preserve-root 删除绝对路径', 'DG-RM-NO-PRESERVE-ROOT');
        return;
      }
    }
    if (recursiveFlag(args)) {
      const hits = dangerTargetsOf(seg, ctx);
      if (hits.length) gateReason(add, 'rm 递归删除灾难级目标 ' + hits.join('、'), 'DG-RM-RECURSIVE');
    }
    return;
  }
  if (WIN_DEL_CMDS.has(name)) {
    const hits = dangerTargetsOf(seg, ctx);
    if (hits.length) gateReason(add, name + ' 作用于灾难级目标 ' + hits.join('、'), 'DG-WIN-DELETE');
    return;
  }
  if (name === 'dd') {
    const oft = args.find((t) => /^of=/i.test(t));
    if (oft) {
      const info = normalizePath(oft.slice(3), ctx.npBash);
      if (info.kind === 'unix' && info.norm.indexOf('/dev/') === 0) {
        gateReason(add, 'dd 直接写入设备 ' + info.norm, 'DG-DD-DEVICE');
      } else if (isDangerTarget(info, ctx)) {
        gateReason(add, 'dd 输出目标是灾难级路径 ' + info.norm, 'DG-DD-TARGET');
      }
    }
    return;
  }
  if (name.indexOf('mkfs') === 0) {
    if (extractPathTokens(seg).some((t) => t.indexOf('/dev/') === 0)) {
      gateReason(add, 'mkfs 格式化块设备', 'DG-MKFS');
    }
    return;
  }
  if (name === 'wipefs') {
    if (extractPathTokens(seg).some((t) => t.indexOf('/dev/') === 0)) {
      gateReason(add, 'wipefs 清除设备签名', 'DG-WIPEFS');
    }
    return;
  }
  if (name === 'diskutil') {
    if (/^(erase|eraseDisk|eraseVolume|eraseAPFS|eraseOpaque|partitionDisk|splitDisk|secureErase|apfs\s+delete)/i.test(rest)) {
      gateReason(add, 'diskutil 抹除磁盘/卷', 'DG-DISKUTIL-WIPE');
    }
    return;
  }
  if (name === 'format') {
    if (args.some((a) => /^[A-Za-z]:$/.test(a) || /^[A-Za-z]:[\\/]/.test(a))) {
      gateReason(add, 'format 格式化盘符', 'DG-FORMAT');
    }
    return;
  }
  if (name === 'cipher') {
    if (/\/w(:|\s|$)/i.test(' ' + rest + ' ')) gateReason(add, 'cipher /w 抹除卷残留数据', 'DG-CIPHER-W');
    return;
  }
  if (name === 'reg') {
    if (/^delete\b/i.test(rest)) {
      const hiveTok = args.find((a) => /^(HK[A-Z]{2}|HKEY_[A-Z_]+)(\\|$)/i.test(a));
      if (hiveTok) {
        const head = hiveTok.split(/[\\/]/)[0].toLowerCase();
        const depth = hiveTok.split(/[\\/]/).filter(Boolean).length - 1;
        if (REG_HIVES[head] && depth <= 1) {
          gateReason(add, 'reg delete 作用于注册表根键 ' + hiveTok, 'DG-REG-DELETE');
        }
      }
    }
    return;
  }
  if (name === 'chmod' || name === 'chown') {
    if (recursiveFlag(args)) {
      const hits = dangerTargetsOf(seg, ctx);
      if (hits.length) gateReason(add, name + ' -R 作用于 ' + hits.join('、'), 'DG-CHMOD-RECURSIVE');
    }
    return;
  }
  if (name === 'vssadmin') {
    if (/^delete\s+shadows/i.test(rest)) gateReason(add, 'vssadmin 删除卷影副本', 'DG-VSSADMIN');
    return;
  }
  // ---- 包装器 ----
  if (name === 'powershell' || name === 'pwsh') {
    const payload = psPayloadOf(args);
    if (payload) psJudge(payload, ctx, depth, add);
    return;
  }
  const inner = unwrapWrapper(name, args);
  if (inner != null) {
    judgeCommand(inner, ctx, depth + 1, add);
    return;
  }
  // ---- PowerShell cmdlet 作为段首（powershell 载荷按 ;| 换行 切段后进入这里）----
  if (PS_REMOVE.has(name)) {
    const hits = dangerTargetsOf(seg, ctx);
    if (hits.length) gateReason(add, 'Remove-Item 作用于灾难级目标 ' + hits.join('、'), 'DG-PS-REMOVE');
    return;
  }
  if (PS_DISK_KILLER.has(name)) {
    gateReason(add, 'PowerShell 磁盘/卷破坏命令 ' + name, 'DG-PS-DISK');
    return;
  }
}

// 从 powershell/pwsh 参数中取出 -Command 载荷；编码载荷/脚本文件返回 null（文档化盲区）
function psPayloadOf(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].toLowerCase();
    if (t === '-encodedcommand' || t === '-e' || t === '-ec' || t === '-file' || t === '-f') return null;
    if (t === '-command' || t === '-c') return args.slice(i + 1).join(' ');
    if (t[0] !== '-') return args.slice(i).join(' '); // 省略 -Command 的隐式载荷
    if (t === '-executionpolicy' || t === '-ep' || t === '-outputformat' || t === '-of' ||
        t === '-inputformat' || t === '-version' || t === '-v' || t === '-psconsolefile' ||
        t === '-windowstyle' || t === '-w' || t === '-configurationname') i++; // 带独立值的开关跳过其值
  }
  return null;
}

// cmd /c、bash -c、wsl 等包装器解包；返回内层命令字符串，非包装器返回 null
function unwrapWrapper(name, args) {
  if (name === 'cmd') {
    const inner = args.filter((t) => !/^\/[cCkK]$/.test(t) && !/^-[cC]$/.test(t)).join(' ');
    return inner ? inner.replace(/^["']|["']$/g, '') : null;
  }
  if (name === 'bash' || name === 'sh' || name === 'zsh' || name === 'dash' || name === 'ksh' || name === 'ash') {
    const ci = args.indexOf('-c');
    if (ci >= 0 && ci + 1 < args.length) return args.slice(ci + 1).join(' ');
    return null;
  }
  if (name === 'wsl' || name === 'busybox') {
    const inner = args.join(' ');
    return inner || null;
  }
  return null;
}

function psJudge(payload, ctx, depth, add) {
  if (depth > MAX_DEPTH || !payload) return;
  for (const sub of splitSegments(payload)) {
    if (ctx.cfg.enable_danger_gate) gateSegment(sub, ctx, depth + 1, add);
    if (ctx.cfg.enable_fence && ctx.projectDir) fenceSegment(sub, ctx, depth + 1, add);
  }
}

/* ================================================================
 * 项目围栏 —— Bash 启发式（只判「写到哪去」，读操作不拦）
 * ================================================================ */

const WRITE_ALL = new Set([
  'rm', 'del', 'rd', 'rmdir', 'erase', 'unlink', 'shred', 'touch', 'mkdir', 'md', 'tee',
  'truncate', 'ren', 'remove-item', 'ri', 'set-content', 'sc', 'add-content', 'ac',
  'out-file', 'new-item', 'ni', 'clear-content', 'compress-archive', 'expand-archive',
]);
const WRITE_LAST = new Set([
  'cp', 'copy', 'mv', 'move', 'ln', 'link', 'rsync', 'scp', 'install', 'robocopy',
  'move-item', 'mi', 'copy-item', 'ci',
]);
const DEST_FLAG = {
  cp: ['-t', '--target-directory'], mv: ['-t', '--target-directory'],
  curl: ['-o', '--output'], wget: ['-o', '--output-document', '-p', '--directory-prefix'],
  tar: ['-c', '--directory'], unzip: ['-d'], '7z': ['-o'], '7za': ['-o'],
  'copy-item': ['-destination'], 'move-item': ['-destination'],
  'expand-archive': ['-destinationpath'],
  'invoke-webrequest': ['-outfile'], iwr: ['-outfile'],
};

function judgeWriteTarget(rawTok, ctx, cmdLabel) {
  const info = normalizePath(rawTok, ctx.npBash);
  if (info.kind === 'null' || info.kind === 'relative' || info.kind === 'empty') return null;
  if (info.kind === 'unresolved' || info.unresolved) {
    return '[' + PLUGIN_ID + ': 路径无法解析] ' + rawTok + ' 含未定义变量，无法判定归属，请改用明确路径';
  }
  if (!ctx.roots || !ctx.roots.length) return null; // ZCODE_PROJECT_DIR 缺失 → 围栏降级
  if (!isInsideRoots(info.norm, ctx.roots, ctx.platform)) {
    return '[' + PLUGIN_ID + ': 越界写入] ' + cmdLabel + ' 的目标 ' + info.norm + ' 不在项目/临时目录等可写根内';
  }
  return null;
}

function fenceSegment(seg, ctx, depth, add) {
  if (depth > MAX_DEPTH) return;
  const targets = [];
  for (const t of extractRedirects(seg)) targets.push(t); // 重定向目标永远判

  const tokens = tokenize(seg);
  const pc = parseCmd(tokens);
  if (pc) {
    const name = pc.name;
    const args = pc.args;
    if (WRITE_ALL.has(name)) {
      for (const t of extractPathTokens(seg)) targets.push(t);
    } else if (WRITE_LAST.has(name)) {
      // 只判目标位（cp 的源不拦）；末参数形如开关（-x、/x 单字母）时不当作目标
      if (args.length) {
        const last = args[args.length - 1];
        if (!/^-/.test(last) && !/^\/[A-Za-z]$/.test(last)) targets.push(last);
      }
    }
    const flags = DEST_FLAG[name];
    if (flags) {
      for (let i = 0; i < args.length; i++) {
        if (flags.indexOf(args[i].toLowerCase()) >= 0 && i + 1 < args.length) targets.push(args[i + 1]);
        if ((name === '7z' || name === '7za') && /^-o/i.test(args[i]) && args[i].length > 2) {
          targets.push(args[i].slice(2)); // 7z 的 -oC:\out 附着形式
        }
      }
    }
    if (name === 'dd') {
      const oft = args.find((t) => /^of=/i.test(t));
      if (oft) targets.push(oft.slice(3));
    }
    if (name === 'powershell' || name === 'pwsh') {
      const payload = psPayloadOf(args);
      if (payload) psJudge(payload, ctx, depth, add); // gate 关闭时围栏侧也兜底判一次
      return;
    }
    const inner = unwrapWrapper(name, args);
    if (inner != null) {
      judgeCommand(inner, ctx, depth + 1, add);
      return;
    }
  }

  for (const t of targets) {
    const label = pc ? pc.name : '重定向';
    const r = judgeWriteTarget(t, ctx, label);
    if (r) add(r);
  }
}

/* ================================================================
 * 命令级入口 / 文件工具入口 / 上下文
 * ================================================================ */

function judgeCommand(cmd, ctx, depth, add) {
  if (depth > MAX_DEPTH) return;
  const cmdStr = String(cmd == null ? '' : cmd);
  if (!cmdStr.trim()) return;

  if (ctx.cfg.enable_danger_gate) {
    // 自定义规则（分号分隔的 JS 正则；编译失败跳过该段不崩溃）
    splitList(ctx.cfg.custom_rules).forEach((rule, idx) => {
      if (!rule) return;
      let re;
      try { re = new RegExp(rule); } catch (e) { return; }
      if (re.test(cmdStr)) {
        add('[' + PLUGIN_ID + ': 自定义规则] 命中自定义规则 #' + (idx + 1) + '（' + rule.slice(0, 60) + '）');
      }
    });
    if (RE_FORK.test(cmdStr)) {
      add('[' + PLUGIN_ID + ': 危险命令] 检测到 fork 炸弹（规则 DG-FORK-BOMB）');
    }
  }

  for (const seg of splitSegments(cmdStr)) {
    if (ctx.cfg.enable_danger_gate) gateSegment(seg, ctx, depth, add);
    if (ctx.cfg.enable_fence && ctx.projectDir) fenceSegment(seg, ctx, depth, add);
  }
}

function judgeFileTool(toolName, target, ctx, add) {
  if (!ctx.cfg.enable_fence || !ctx.projectDir) return;
  let info = normalizePath(target, ctx.npFile);
  if (info.kind === 'empty') return;
  if (info.kind === 'relative') {
    // 文件工具目标理论上总是绝对路径；万一相对，按项目根解析后再判
    const sep = ctx.platform === 'win32' ? '\\' : '/';
    info = normalizePath(ctx.projectDir + sep + info.norm, ctx.npFile);
  }
  if (info.kind === 'null' || info.kind === 'relative' || info.kind === 'empty') return;
  if (info.kind === 'unresolved' || info.unresolved) {
    add('[' + PLUGIN_ID + ': 路径无法解析] ' + target + ' 含未定义变量，无法判定归属');
    return;
  }
  if (!isInsideRoots(info.norm, ctx.roots, ctx.platform)) {
    add('[' + PLUGIN_ID + ': 越界写入] ' + (toolName || 'Write') + ' 目标 ' + info.norm + ' 不在项目/临时目录等可写根内');
  }
}

function buildContext(env) {
  const platform = process.platform;
  const loaded = loadConfig(env);
  const npFile = { platform, env, msysAlways: false };
  const npBash = { platform, env, msysAlways: true };

  // 项目根（宿主注入的 ZCODE_PROJECT_DIR；缺失则围栏整体降级）
  let projectDir = null;
  if (env.ZCODE_PROJECT_DIR) {
    const info = normalizePath(env.ZCODE_PROJECT_DIR, npFile);
    if (info.kind === 'drive' || info.kind === 'unix' || info.kind === 'unc') {
      projectDir = realPathBest(info.norm, platform) || info.norm;
    }
  }

  const homeInfo = normalizePath(homeOf(env), npBash);
  const homeNorm = (homeInfo.kind === 'drive' || homeInfo.kind === 'unix') ? homeInfo.norm : '';

  const ctx = {
    cfg: loaded.cfg, cfgPath: loaded.cfgPath, notes: loaded.notes,
    platform, env, projectDir, homeNorm, npFile, npBash, roots: null,
  };

  if (projectDir) {
    // 可写根 = 项目根 + 当前平台真实临时目录 + 用户配置的额外可写根
    const roots = [projectDir];
    const temps = platform === 'win32'
      ? [env.TEMP, env.TMP, os.tmpdir()]     // Windows 读 TEMP/TMP（真实临时目录）
      : [env.TMPDIR, '/tmp', os.tmpdir()];   // Unix 用 TMPDIR，/tmp 保留
    const extras = splitList(ctx.cfg.extra_writable_roots);
    for (const t of temps.concat(extras)) {
      if (!t) continue;
      const i = normalizePath(t, npFile);
      if (i.kind !== 'drive' && i.kind !== 'unix' && i.kind !== 'unc') continue;
      const r = realPathBest(i.norm, platform) || i.norm;
      if (!roots.some((x) => isUnder(r, x, platform) || isUnder(x, r, platform))) roots.push(r);
    }
    ctx.roots = roots;
  }
  return ctx;
}

function judgePayload(p, env) {
  const ctx = buildContext(env);
  const reasons = [];
  const add = (r) => { if (reasons.indexOf(r) < 0) reasons.push(r); };
  const tool = String((p && p.tool_name) || '');
  const ti = (p && p.tool_input) || {};
  let detail = '';

  if (/^bash$/i.test(tool)) {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    detail = cmd;
    judgeCommand(cmd, ctx, 0, add);
  } else {
    // 文件工具目标在 tool_input.file_path（兼容 path）
    const target = (typeof ti.file_path === 'string' && ti.file_path) ||
      (typeof ti.path === 'string' && ti.path) || '';
    detail = target;
    if (target) judgeFileTool(tool, target, ctx, add);
  }
  return { ctx, reasons, detail, tool };
}

/* ================================================================
 * 决策输出 / 决策日志
 * ================================================================ */

// 严格 schema，多余 key 宿主会拒收；本插件只有一种决策：ask
function askJson(reasons) {
  const reason = reasons.join('；');
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason.length > 800 ? reason.slice(0, 800) + '…' : reason,
    },
  }) + '\n';
}

function snippet(s) {
  s = String(s == null ? '' : s);
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

function dataDir(env) {
  if (env.ZCODE_FENCE_DATA_DIR) return env.ZCODE_FENCE_DATA_DIR;
  const base = path.join(homeOf(env), '.zcode', 'cli', 'plugins', 'data');
  if (env.ZCODE_PLUGIN_DATA) return env.ZCODE_PLUGIN_DATA;
  try {
    const hit = fs.readdirSync(base).find((n) => n === PLUGIN_ID || n.indexOf(PLUGIN_ID + '@') === 0);
    if (hit) return path.join(base, hit); // 宿主实际目录形如 <插件id>@<市场名>
  } catch (e) { /* 目录不存在则落回裸 id */ }
  return path.join(base, PLUGIN_ID);
}

function writeLog(record, env, enabled) {
  if (!enabled) return;
  try {
    const dir = dataDir(env);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'decisions.log');
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.old'); // 简单轮转
    } catch (e) { /* 首次写入无文件 */ }
    const line = JSON.stringify(Object.assign({
      ts: new Date().toISOString(), pid: process.pid, platform: process.platform,
    }, record));
    fs.appendFileSync(file, line + '\n');
  } catch (e) { /* 日志失败不影响判定 */ }
}

/**
 * 核心执行：输入 hook stdin 文本，产出 { out, record }。
 * out 为空字符串 = 沉默放行（交还宿主按其自身模式处理）。
 */
function runGuard(stdinText, env, source) {
  let payload = null;
  let parseErr = null;
  try { payload = JSON.parse(stdinText); } catch (e) { parseErr = e; }

  if (parseErr) {
    const rec = { source, level: 'error', verdict: 'error', note: 'stdin 非法 JSON: ' + parseErr.message, stdin: snippet(stdinText) };
    return { out: '', record: rec };
  }
  try {
    const r = judgePayload(payload, env);
    const rec = {
      source, level: 'info',
      verdict: r.reasons.length ? 'ask' : 'silent',
      tool: r.tool, detail: snippet(r.detail),
      reasons: r.reasons,
      project_dir: r.ctx.projectDir || '',
      config_notes: r.ctx.notes,
    };
    return { out: r.reasons.length ? askJson(r.reasons) : '', record: rec };
  } catch (e) {
    const rec = { source, level: 'error', verdict: 'error', note: '内部异常: ' + ((e && e.stack) || e) };
    return { out: '', record: rec }; // fail-open
  }
}

/* ================================================================
 * CLI 入口
 * ================================================================ */

const HELP = [
  'zcode-fence —— ZCode 确定性围栏插件（危险命令门 + 项目围栏）',
  '',
  '用法：',
  '  node guard.js                       # hook 模式：从 stdin 读取 PreToolUse 载荷',
  '  node guard.js --eval "<命令>"        # 自测：判定一条 Bash 命令',
  '  node guard.js --eval-write "<路径>"  # 自测：判定一个 Write 目标路径',
  '  node guard.js --eval-edit "<路径>"   # 自测：判定一个 Edit 目标路径',
  '',
  'stdout 与 hook 模式完全一致（ask 输出决策 JSON，放行无输出）；',
  '人读摘要打到 stderr。可用环境变量：',
  '  ZCODE_PROJECT_DIR   项目根（缺失则围栏降级，仅危险门生效）',
  '  ZCODE_FENCE_CONFIG  配置文件路径（默认 ~/.zcode/cli/config.json）',
  '  ZCODE_FENCE_DATA_DIR 决策日志目录',
].join('\n');

function readAllStdin(cb) {
  const chunks = [];
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    cb(chunks.length ? Buffer.concat(chunks).toString('utf8') : '');
  };
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 4000).unref();
}

function evalSummary(record) {
  const lines = ['[zcode-fence] decision=' + (record.verdict === 'ask' ? 'ask' : record.verdict === 'silent' ? 'silent（无输出，交还宿主）' : record.verdict)];
  if (record.reasons && record.reasons.length) {
    for (const r of record.reasons) lines.push('  - ' + r);
  }
  process.stderr.write(lines.join('\n') + '\n');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (argv[0] === '--eval' || argv[0] === '--eval-write' || argv[0] === '--eval-edit') {
    const target = argv.slice(1).join(' ');
    const payload = argv[0] === '--eval'
      ? { tool_name: 'Bash', tool_input: { command: target } }
      : { tool_name: argv[0] === '--eval-write' ? 'Write' : 'Edit', tool_input: { file_path: target } };
    const r = runGuard(JSON.stringify(payload), process.env, 'eval');
    writeLog(r.record, process.env, loadConfig(process.env).cfg.enable_log); // 日志开关与 hook 模式一致
    process.stdout.write(r.out);
    evalSummary(r.record);
    return;
  }
  // hook 模式
  readAllStdin((text) => {
    const r = runGuard(text, process.env, 'hook');
    const logEnabled = loadConfig(process.env).cfg.enable_log;
    writeLog(r.record, process.env, logEnabled);
    process.stdout.write(r.out);
  });
}

module.exports = {
  PLUGIN_ID,
  normalizePath,
  expandVars,
  splitSegments,
  tokenize,
  parseCmd,
  extractPathTokens,
  extractRedirects,
  isUnder,
  isInsideRoots,
  realPathBest,
  isDangerTarget,
  loadConfig,
  splitList,
  buildContext,
  judgeCommand,
  judgeFileTool,
  judgeWriteTarget,
  gateSegment,
  fenceSegment,
  judgePayload,
  runGuard,
};

if (require.main === module) main();
