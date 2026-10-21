#!/usr/bin/env node
'use strict';

/*
 * zcode-fence —— ZCode 确定性围栏插件（危险命令门 + 项目围栏 + 可选决策模型审核）
 *
 * 设计原则：
 *  - 确定性规则：同一条命令永远得到同一判定，无 AI 判断；默认无网络请求，仅在显式开启
 *    可选决策模型审核层时才访问配置端点；零 npm 依赖（Node >= 16）。
 *  - 零误报哲学：项目内日常操作一律放行；只拦「灾难级命令」「写到项目之外」和「不可逆损失」三类。
 *  - ask-only：永不输出 allow/deny。命中违规输出 ask（弹确认），其余无输出 exit 0，
 *    交还宿主按其自身权限模式处理 —— 插件只加锁，不改锁。
 *  - fail-open：stdin 解析失败或内部异常时放行（exit 0 无输出），异常写入决策日志留痕。
 *
 * 判定协议遵循 ZCode 宿主 PreToolUse hook 的 hookSpecificOutput schema（严格校验，多余 key 宿主拒收）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const tls = require('tls');

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
  lock_session_root: true,
  custom_rules: '',
  extra_writable_roots: '',
  enable_log: true,
  // 可选决策模型审核层（默认关闭，不配置端点时绝不发起网络请求）
  enable_decision_model: false,
  decision_model_endpoint: '',
  decision_model_model: '',
  decision_model_api_key: '',
  decision_model_threshold: 0.6,
  decision_model_timeout_ms: 3500,
  decision_model_headers: '',
  decision_model_proxy: '',
  decision_model_prompt: '',
};

function clampNumber(v, dflt, min, max) {
  const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).trim());
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

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
          cfg.lock_session_root = truthy(user.lock_session_root, true);
          cfg.custom_rules = typeof user.custom_rules === 'string' ? user.custom_rules : '';
          cfg.extra_writable_roots = typeof user.extra_writable_roots === 'string' ? user.extra_writable_roots : '';
          cfg.enable_log = truthy(user.enable_log, true);
          cfg.enable_decision_model = truthy(user.enable_decision_model, false);
          cfg.decision_model_endpoint = typeof user.decision_model_endpoint === 'string' ? user.decision_model_endpoint.trim() : '';
          cfg.decision_model_model = typeof user.decision_model_model === 'string' ? user.decision_model_model.trim() : '';
          cfg.decision_model_api_key = typeof user.decision_model_api_key === 'string' ? user.decision_model_api_key : '';
          cfg.decision_model_threshold = clampNumber(user.decision_model_threshold, 0.6, 0, 1);
          cfg.decision_model_timeout_ms = Math.round(clampNumber(user.decision_model_timeout_ms, 3500, 100, 4000));
          cfg.decision_model_headers = typeof user.decision_model_headers === 'string' ? user.decision_model_headers : '';
          cfg.decision_model_proxy = typeof user.decision_model_proxy === 'string' ? user.decision_model_proxy.trim() : '';
          cfg.decision_model_prompt = typeof user.decision_model_prompt === 'string' ? user.decision_model_prompt : '';
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

// 与 splitSegments 同规则，但保留每段前的分隔符（识别「下载器 | shell」管道）
function splitSegmentsWithOps(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let op = '';
  const s = String(cmd == null ? '' : cmd);
  const flush = (nextOp) => {
    const seg = cur.trim();
    if (seg) out.push({ seg, op });
    cur = '';
    op = nextOp;
  };
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
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') {
      let sep = ch;
      if ((ch === '|' || ch === '&') && s[i + 1] === ch) { sep = ch + ch; i++; }
      flush(sep);
      continue;
    }
    cur += ch;
  }
  flush('');
  return out;
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

// 包装器选项表：跳过选项链（含带值选项）后继续 dispatch 内层命令。
// value 为需要独立值的选项；attached 为可附着写法（-o0 / -o 0）的选项；
// 其余开关一律按无值跳过 —— 宁可多剥一层，也不能让选项链把内层命令藏起来。
const WRAPPER_SPECS = {
  sudo: {
    value: ['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-h', '--host',
      '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout', '-D', '--chdir'],
  },
  env: {
    value: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string', '--block-signal',
      '--default-signal', '--ignore-signal'],
  },
  nice: {
    value: ['-n', '--adjustment'],
  },
  timeout: {
    value: ['-s', '--signal', '-k', '--kill-after'],
    positional: 1, // 时长参数（timeout 10 <cmd>）
  },
  stdbuf: {
    value: ['--input', '--output', '--error'],
    attached: ['-i', '-o', '-e'],
  },
  nohup: {},
  time: {
    value: ['-o', '--output', '-f', '--format'],
  },
  command: {},
  exec: {
    value: ['-a'],
  },
  strace: {
    value: ['-o', '-e', '-p', '-s', '-u', '-E', '-I', '-b', '-a', '--output', '--trace', '--expr'],
  },
  wsl: {
    value: ['-d', '--distribution', '-u', '--user', '-e', '--exec', '--cd'],
  },
};
const PREFIX_CMDS = new Set(['valgrind', 'busybox']);
// bash 控制流关键字：分段后可能落在段首（`; then rm ...`），跳过后继续 dispatch 真正的命令词
const CONTROL_FLOW = new Set(['then', 'do', 'else', 'elif', 'done', 'fi', 'esac', 'in', '{', '}', '!']);

// 跳过包装器名字之后的选项链与固定位置参数，返回内层命令词下标
function skipOptionChain(tokens, start, spec) {
  const value = spec.value || [];
  const attached = spec.attached || [];
  let i = start;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '--') { i++; break; }
    if (t === '-' || t[0] !== '-') break;
    if (t.slice(0, 2) === '--' && t.indexOf('=') > 0) { i++; continue; } // --opt=value
    if (value.indexOf(t) >= 0) { i += 2; continue; }
    if (t.length === 2 && attached.indexOf(t) >= 0) { i += 2; continue; } // -o 0
    i++; // 普通开关、组合短开关、附着式（-o0）
  }
  let pos = spec.positional || 0;
  while (pos > 0 && i < tokens.length && tokens[i][0] !== '-') { i++; pos--; }
  return i;
}

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
    if (WRAPPER_SPECS[base]) { i = skipOptionChain(tokens, i + 1, WRAPPER_SPECS[base]); continue; }
    if (PREFIX_CMDS.has(base) || CONTROL_FLOW.has(base)) { i++; continue; }
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
// 关机/重启族：无路径的系统级破坏（2026-09 调研 Codex/Kimi 后补充；正常开发工作流不会触碰）
const POWER_CMDS = new Set(['shutdown', 'halt', 'poweroff', 'reboot', 'stop-computer', 'restart-computer']);
const SYSTEMCTL_KILLERS = new Set(['poweroff', 'reboot', 'halt', 'kexec']);
// 持久化变更：重启后仍生效；start/stop/restart/status 属日常操作，放行
const SYSTEMCTL_PERSIST = new Set(['enable', 'disable', 'mask', 'unmask', 'reenable']);
const LAUNCHCTL_PERSIST = new Set(['load', 'unload', 'bootstrap', 'bootout']);
const BCDEDIT_WRITE_FLAGS = /^\/(set|delete|import|restore)$/i;
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

/* ---- 命令内 cwd 状态与相对路径解析（cd/pushd/popd 跟踪） ---- */

// 相对路径按当前命令内 cwd 解析；cwd 未知时返回 null（fail-open，不判归属）
function resolveAgainstCwd(info, cwd, ctx) {
  if (!info || info.kind !== 'relative') return info;
  if (!cwd) return null;
  const sep = cwd.indexOf('\\') >= 0 ? '\\' : '/';
  const joined = cwd.replace(/[\\\/]+$/, '') + sep + info.norm;
  const r = normalizePath(joined, ctx.npBash);
  if (r.kind === 'drive' || r.kind === 'unix' || r.kind === 'unc') return r;
  return null;
}

function resolveTarget(raw, ctx, cwd) {
  const info = normalizePath(raw, ctx.npBash);
  // 未定义变量（如 Unix 上的 %USERPROFILE%）先于相对路径解析返回：否则 cwd 未知时
  // 会被当作普通相对路径直接放行，丢失「无法解析 → ask」语义（CI FB-22 回归）。
  if (info.kind === 'unresolved' || info.unresolved) return info;
  if (info.kind === 'relative') return cwd ? resolveAgainstCwd(info, cwd, ctx) : null;
  return info;
}

// 命令操作数（跳过开关与 Windows /x 单字母开关）
function operandTokens(args) {
  const out = [];
  for (const t of args) {
    if (!t) continue;
    if (t.length > 1 && t[0] === '-') continue;
    if (/^\/[A-Za-z]$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

function dangerTargetsOf(args, ctx, cwd) {
  const out = [];
  for (const t of operandTokens(args)) {
    const info = resolveTarget(t, ctx, cwd);
    if (info && isDangerTarget(info, ctx)) out.push(info.norm);
  }
  return out;
}

/* ---- Git 不可逆操作（即使发生在项目内也 ask） ---- */

const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace',
  '--exec-path', '--super-prefix', '--config-env']);
const GIT_GLOBAL_FLAG = new Set(['-p', '--paginate', '--no-pager', '--bare', '--literal-pathspecs',
  '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects',
  '--version', '--help', '-h']);

function gitCommandOf(args) {
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { i++; break; }
    if (GIT_GLOBAL_VALUE.has(t)) { i++; continue; }
    if (t.indexOf('--') === 0 && t.indexOf('=') > 0) continue;
    if (GIT_GLOBAL_FLAG.has(t)) continue;
    if (t[0] === '-') continue;
    break;
  }
  return { cmd: args[i] || '', rest: args.slice(i + 1) };
}

function anyFlag(rest, flags) {
  return rest.some((t) => flags.indexOf(t) >= 0);
}

function anyShortWith(rest, letter) {
  const re = new RegExp('^-[A-Za-z]*' + letter + '[A-Za-z]*$');
  return rest.some((t) => re.test(t));
}

// 返回 {label, rule} 或 null
function gitDisposition(args) {
  const g = gitCommandOf(args);
  const cmd = g.cmd;
  const rest = g.rest;
  if (!cmd) return null;
  // --help / -h 是显式安全形态（任何子命令）
  if (anyFlag(rest, ['--help', '-h'])) return null;
  const dryRun = anyFlag(rest, ['--dry-run', '-n']);

  if (cmd === 'push') {
    if (dryRun) return null;
    if (rest.some((t) => t === '--force' || t === '--force-with-lease' ||
        t.indexOf('--force-with-lease=') === 0 || t === '--force-if-includes' ||
        t === '--delete' || t === '--mirror' || t.charAt(0) === '+') ||
        anyShortWith(rest, 'f') || anyShortWith(rest, 'd')) {
      return { label: '强制/删除/镜像推送', rule: 'DG-GIT-PUSH-FORCE' };
    }
    return null;
  }
  if (cmd === 'branch') {
    if (anyShortWith(rest, 'D') || (anyFlag(rest, ['--delete', '-d']) && anyFlag(rest, ['--force', '-f']))) {
      return { label: '强制删除分支', rule: 'DG-GIT-BRANCH-DELETE' };
    }
    return null;
  }
  if (cmd === 'tag') {
    if (anyFlag(rest, ['-d', '--delete'])) return { label: '删除标签', rule: 'DG-GIT-TAG-DELETE' };
    return null;
  }
  if (cmd === 'reset') {
    if (anyFlag(rest, ['--hard', '--merge'])) return { label: '--hard/--merge 丢弃改动', rule: 'DG-GIT-RESET-HARD' };
    return null;
  }
  if (cmd === 'clean') {
    if (dryRun || anyFlag(rest, ['--no-force'])) return null;
    if (anyFlag(rest, ['--force']) || anyShortWith(rest, 'f')) {
      return { label: '强制删除未跟踪文件', rule: 'DG-GIT-CLEAN-FORCE' };
    }
    return null;
  }
  if (cmd === 'checkout') {
    if (anyFlag(rest, ['--force']) || anyShortWith(rest, 'f') || anyShortWith(rest, 'B') ||
        rest.indexOf('--') >= 0 || rest.indexOf('.') >= 0) {
      return { label: '丢弃工作区改动', rule: 'DG-GIT-CHECKOUT-DISCARD' };
    }
    return null;
  }
  if (cmd === 'restore') {
    const stagedOnly = anyFlag(rest, ['--staged', '-S']) && !anyFlag(rest, ['--worktree', '-W']);
    if (stagedOnly) return null;
    return { label: '丢弃工作区改动', rule: 'DG-GIT-RESTORE-DISCARD' };
  }
  if (cmd === 'stash') {
    if (rest[0] === 'clear' || rest[0] === 'drop') {
      return { label: 'stash ' + rest[0] + ' 丢弃暂存', rule: 'DG-GIT-STASH-DROP' };
    }
    return null;
  }
  if (cmd === 'worktree' && rest[0] === 'remove') {
    if (anyFlag(rest, ['--force']) || anyShortWith(rest, 'f')) {
      return { label: 'worktree remove --force', rule: 'DG-GIT-WORKTREE-FORCE' };
    }
    return null;
  }
  if ((cmd === 'rebase' || cmd === 'merge') && anyFlag(rest, ['--abort'])) {
    return { label: '--abort 中止并丢弃进度', rule: 'DG-GIT-ABORT' };
  }
  if (cmd === 'reflog' && rest[0] === 'delete') {
    return { label: 'reflog delete 删除历史记录', rule: 'DG-GIT-REFLOG-DELETE' };
  }
  if (cmd === 'rm') {
    if (anyFlag(rest, ['--force']) || anyShortWith(rest, 'f') || anyShortWith(rest, 'r')) {
      return { label: '递归/强制删除版本控制文件', rule: 'DG-GIT-RM-FORCE' };
    }
    return null;
  }
  return null;
}

function gitJudge(args, ctx, add) {
  const d = gitDisposition(args);
  if (!d) return;
  const cmd = gitCommandOf(args).cmd;
  gateReason(add, 'git ' + cmd + ' ' + d.label, d.rule);
}

/* ---- find：-delete / -exec 删除按查找根判定 ---- */

const DELETE_CMDS = new Set(['rm', 'del', 'rd', 'rmdir', 'erase', 'shred', 'unlink', 'remove-item', 'ri']);
const FIND_EXPR_START = new Set(['!', '(', ')', ',']);

function findParts(args) {
  const roots = [];
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i];
    if (t[0] === '-' || FIND_EXPR_START.has(t)) break;
    roots.push(t);
  }
  return { roots: roots.length ? roots : ['.'], expr: args.slice(i) };
}

function findExecCommands(expr) {
  const cmds = [];
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] !== '-exec' && expr[i] !== '-execdir' && expr[i] !== '-ok' && expr[i] !== '-okdir') continue;
    const sub = [];
    for (let j = i + 1; j < expr.length; j++) {
      const t = expr[j];
      if (t === ';' || t === '\\;' || t === '+') break;
      sub.push(t);
    }
    if (sub.length) cmds.push(sub);
  }
  return cmds;
}

function findJudge(args, ctx, depth, add, cwd) {
  if (depth > MAX_DEPTH) return;
  const parts = findParts(args);
  const hasDelete = parts.expr.indexOf('-delete') >= 0;
  const execs = findExecCommands(parts.expr);
  const execDeletes = execs.filter((sub) => {
    const pc = parseCmd(sub);
    return pc && DELETE_CMDS.has(pc.name);
  });
  if (hasDelete || execDeletes.length) {
    for (const root of parts.roots) {
      if (ctx.cfg.enable_danger_gate) {
        const info = resolveTarget(root, ctx, cwd);
        if (info && isDangerTarget(info, ctx)) {
          gateReason(add, 'find 的查找根 ' + info.norm + ' 是灾难级目录，表达式含删除', 'DG-FIND-DELETE');
        }
      }
      if (ctx.cfg.enable_fence && ctx.projectDir) {
        const r = judgeWriteTarget(root, ctx, 'find', cwd);
        if (r) add(r);
      }
    }
  }
  // -exec 的内层命令照常递归判定（find . -exec rm -rf / \;）
  for (const sub of execs) judgeCommand(sub.join(' '), ctx, depth + 1, add, cwd);
}

/* ---- xargs：子命令是删除/shell 时因输入动态而 ask ---- */

const XARGS_VALUE_OPTS = new Set(['-I', '-n', '-P', '-L', '-l', '-s', '-E', '-e', '-d', '-a',
  '--delimiter', '--max-args', '--max-procs', '--max-lines', '--max-chars', '--arg-file',
  '--eof', '--replace', '--process-slot-var']);

function xargsCommandOf(args) {
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { i++; break; }
    if (t[0] !== '-') break;
    if (t.length === 2 && XARGS_VALUE_OPTS.has(t)) i++;
  }
  return parseCmd(args.slice(i));
}

/* ---- sed -i：文件操作数按写目标判 ---- */

function sedWriteFiles(args) {
  let inPlace = false;
  let scriptSeen = false;
  let skipNext = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (skipNext) { skipNext = false; scriptSeen = true; continue; }
    if (t === '--') {
      for (const f of args.slice(i + 1)) if (f[0] !== '-') files.push(f);
      break;
    }
    if (t === '-i' || t === '--in-place' || t.indexOf('--in-place=') === 0 || /^-i./.test(t)) {
      inPlace = true; continue;
    }
    if (/^-[A-Za-z]*i[A-Za-z]*$/.test(t)) { inPlace = true; continue; } // 组合短开关 -ni
    if (t === '-e' || t === '--expression' || t === '-f' || t === '--file') { skipNext = true; continue; }
    if (t[0] === '-' && t.length > 1) continue; // 其他开关（保守跳过）
    if (!scriptSeen) { scriptSeen = true; continue; } // 第一个非选项是脚本
    files.push(t);
  }
  return inPlace ? files : [];
}

function sedJudge(args, ctx, add, cwd) {
  for (const f of sedWriteFiles(args)) {
    if (ctx.cfg.enable_danger_gate) {
      const info = resolveTarget(f, ctx, cwd);
      if (info && isDangerTarget(info, ctx)) {
        gateReason(add, 'sed -i 就地编辑灾难级目标 ' + info.norm, 'DG-SED-INPLACE');
      }
    }
    if (ctx.cfg.enable_fence && ctx.projectDir) {
      const r = judgeWriteTarget(f, ctx, 'sed -i', cwd);
      if (r) add(r);
    }
  }
}

/* ---- chmod / chown / chgrp：所有路径操作数进入写目标判定 ---- */

function metaOperands(name, args) {
  const out = [];
  let ownerSkipped = false;
  // --reference 形态不需要 owner 操作数，所有非选项参数都是目标文件
  const hasReference = name !== 'chmod' && args.some((a) => a === '--reference' || a.indexOf('--reference=') === 0);
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--') { for (const f of args.slice(i + 1)) out.push(f); break; }
    if (t[0] === '-' && t.length > 1) continue;                      // 开关（含 --reference=）
    if (/^[0-7]{3,4}$/.test(t)) continue;                            // chmod 数字模式
    if (/^[ugoa]*[+-=][rwxXst]*$/.test(t)) continue;                 // chmod 符号模式
    if ((name === 'chown' || name === 'chgrp') && !hasReference) {
      if (!ownerSkipped) { ownerSkipped = true; continue; }          // 第一个操作数是 owner/group
    }
    out.push(t);
  }
  return out;
}

function gateReason(add, label, rule) {
  add('[' + PLUGIN_ID + ': 危险命令] ' + label + '（规则 ' + rule + '）');
}

const STORAGE_TOOLS = new Set(['mount', 'umount', 'unmount', 'fdisk', 'parted']);
const PERSIST_TOOLS = new Set(['systemctl', 'crontab', 'iptables', 'ip6tables', 'netsh', 'sc', 'launchctl', 'schtasks']);

// 系统存储/分区工具：列表/查询形态放行，其余变更 ask
function storageJudge(name, args, add) {
  if (name === 'mount') {
    if (!args.length || args.some((a) => a === '-l' || a === '--list' || a === '--help' || a === '-h')) return;
    gateReason(add, 'mount 挂载/重挂载文件系统', 'DG-MOUNT');
    return;
  }
  if (name === 'umount' || name === 'unmount') {
    if (!args.length || args.some((a) => a === '--help' || a === '-h')) return;
    gateReason(add, 'umount 卸载文件系统', 'DG-UMOUNT');
    return;
  }
  if (name === 'fdisk') {
    if (args.some((a) => /^-[A-Za-z]*l/.test(a) || a === '--list' || a === '--help' || a === '-h')) return;
    gateReason(add, 'fdisk 分区表操作', 'DG-FDISK');
    return;
  }
  if (name === 'parted') {
    if (!args.length || args.some((a) => a === 'print' || a === '-l' || a === '--list' ||
        a === '--help' || a === '-h')) return;
    gateReason(add, 'parted 分区表操作', 'DG-PARTED');
  }
}

// 系统持久化：重启后仍生效的变更 ask；日常启停/查询放行
function persistenceJudge(name, args, add) {
  const rest = args.join(' ');
  if (name === 'systemctl') {
    const killer = args.find((a) => SYSTEMCTL_KILLERS.has(String(a).toLowerCase()));
    if (killer) {
      gateReason(add, 'systemctl 电源控制子命令 ' + killer, 'DG-SYSTEMCTL-POWER');
      return;
    }
    const persist = args.find((a) => SYSTEMCTL_PERSIST.has(String(a).toLowerCase()));
    if (persist) gateReason(add, 'systemctl ' + persist + ' 持久化服务状态', 'DG-SYSTEMCTL-PERSIST');
    return;
  }
  if (name === 'crontab') {
    if (args.some((a) => a === '-r' || a === '--remove')) {
      gateReason(add, 'crontab -r 删除定时任务', 'DG-CRON-REMOVE');
    }
    return;
  }
  if (name === 'iptables' || name === 'ip6tables') {
    if (args.some((a) => a === '-F' || a === '--flush')) {
      gateReason(add, name + ' flush 清空防火墙规则', 'DG-IPTABLES-FLUSH');
    }
    return;
  }
  if (name === 'netsh') {
    const low = args.map((a) => String(a).toLowerCase());
    const firewall = low.some((a) => a === 'advfirewall' || a === 'firewall');
    const changing = low.some((a) => a === 'set' || a === 'reset');
    const disabling = low.some((a) => a === 'off' || a === 'disable' || a === 'disabled');
    if (firewall && changing && disabling) {
      gateReason(add, 'netsh 关闭防火墙', 'DG-NETSH-FIREWALL');
    }
    return;
  }
  if (name === 'sc') {
    if (/^delete\b/i.test(rest)) gateReason(add, 'sc delete 删除服务', 'DG-SC-DELETE');
    return;
  }
  if (name === 'launchctl') {
    const sub = args.find((a) => LAUNCHCTL_PERSIST.has(String(a).toLowerCase()));
    if (sub) gateReason(add, 'launchctl ' + sub + ' 持久化/变更服务', 'DG-LAUNCHCTL-PERSIST');
    return;
  }
  if (name === 'schtasks') {
    const hit = args.find((a) => /^\/(create|delete|change)$/i.test(a));
    if (hit) gateReason(add, 'schtasks ' + hit + ' 修改计划任务', 'DG-SCHTASKS-PERSIST');
  }
}

function gateSegment(seg, ctx, depth, add, cwd) {
  if (depth > MAX_DEPTH) return;
  const tokens = tokenize(seg);
  const pc = parseCmd(tokens);
  if (!pc) return;
  const name = pc.name;
  const args = pc.args;
  const rest = args.join(' ');

  if (name === 'rm') {
    if (args.indexOf('--no-preserve-root') >= 0) {
      if (operandTokens(args).length) {
        gateReason(add, 'rm 使用 --no-preserve-root 删除绝对路径', 'DG-RM-NO-PRESERVE-ROOT');
        return;
      }
    }
    if (recursiveFlag(args)) {
      const hits = dangerTargetsOf(args, ctx, cwd);
      if (hits.length) gateReason(add, 'rm 递归删除灾难级目标 ' + hits.join('、'), 'DG-RM-RECURSIVE');
    }
    return;
  }
  if (WIN_DEL_CMDS.has(name)) {
    const hits = dangerTargetsOf(args, ctx, cwd);
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
      let rootHit = false;
      const hiveTok = args.find((a) => /^(HK[A-Z]{2}|HKEY_[A-Z_]+)(\\|$)/i.test(a));
      if (hiveTok) {
        const head = hiveTok.split(/[\\/]/)[0].toLowerCase();
        const depth = hiveTok.split(/[\\/]/).filter(Boolean).length - 1;
        if (REG_HIVES[head] && depth <= 1) {
          gateReason(add, 'reg delete 作用于注册表根键 ' + hiveTok, 'DG-REG-DELETE');
          rootHit = true;
        }
      }
      if (!rootHit) gateReason(add, 'reg delete 修改注册表', 'DG-REG-PERSIST');
    } else if (/^(add|import)\b/i.test(rest)) {
      gateReason(add, 'reg ' + /^(add|import)/i.exec(rest)[0] + ' 持久化注册表变更', 'DG-REG-PERSIST');
    }
    return;
  }
  if (name === 'chmod' || name === 'chown') {
    if (recursiveFlag(args)) {
      const hits = dangerTargetsOf(args, ctx, cwd);
      if (hits.length) gateReason(add, name + ' -R 作用于 ' + hits.join('、'), 'DG-CHMOD-RECURSIVE');
    }
    return;
  }
  if (name === 'vssadmin') {
    if (/^delete\s+shadows/i.test(rest)) gateReason(add, 'vssadmin 删除卷影副本', 'DG-VSSADMIN');
    return;
  }
  if (POWER_CMDS.has(name)) {
    // shutdown /a 中止关机、-k 仅广播警告 → 放行（零误报）
    if (name === 'shutdown' && args.some((a) => /^[-/](a|k)$/i.test(a))) return;
    gateReason(add, name + ' 关机/重启命令', 'DG-POWEROFF');
    return;
  }
  if (PERSIST_TOOLS.has(name)) {
    persistenceJudge(name, args, add);
    return;
  }
  if (name === 'init' || name === 'telinit') {
    if (args[0] === '0' || args[0] === '6') gateReason(add, name + ' 切换运行级 ' + args[0] + '（关机/重启）', 'DG-INIT-RUNLEVEL');
    return;
  }
  if (name === 'bcdedit') {
    if (args.some((a) => BCDEDIT_WRITE_FLAGS.test(a))) gateReason(add, 'bcdedit 写引导配置', 'DG-BCDEDIT-WRITE');
    return;
  }
  if (name === 'diskpart') {
    gateReason(add, 'diskpart 磁盘分区工具', 'DG-DISKPART');
    return;
  }
  if (STORAGE_TOOLS.has(name)) {
    storageJudge(name, args, add);
    return;
  }
  if (name === 'git') {
    gitJudge(args, ctx, add);
    return;
  }
  if (name === 'find') {
    findJudge(args, ctx, depth, add, cwd);
    return;
  }
  if (name === 'xargs') {
    const sub = xargsCommandOf(args);
    if (sub) {
      if (DELETE_CMDS.has(sub.name)) {
        gateReason(add, 'xargs 把动态输入交给删除命令 ' + sub.name + '，目标无法静态确认', 'DG-XARGS-DELETE');
      } else if (SHELLS.has(sub.name) || sub.name === 'cmd' || sub.name === 'powershell' ||
                 sub.name === 'pwsh' || sub.name === 'eval') {
        gateReason(add, 'xargs 把动态输入交给 shell 执行', 'DG-XARGS-SHELL');
      }
    }
    return;
  }
  if (name === 'sed' || name === 'gsed') {
    sedJudge(args, ctx, add, cwd);
    return;
  }
  // ---- 包装器 ----
  if (name === 'powershell' || name === 'pwsh') {
    const payload = psPayloadOf(args);
    if (payload) psJudge(payload, ctx, depth, add, cwd);
    return;
  }
  // ---- 解释器内嵌脚本（node -e / python -c / perl -e / ruby -e / php -r / awk …）----
  const script = scriptPayloadOf(name, args);
  if (script != null) {
    interpreterJudge(name, script, ctx, depth, add, cwd);
    return;
  }
  const inner = unwrapWrapper(name, args);
  if (inner != null) {
    judgeCommand(inner, ctx, depth + 1, add, cwd);
    return;
  }
  // ---- PowerShell cmdlet 作为段首（powershell 载荷按 ;| 换行 切段后进入这里）----
  if (PS_REMOVE.has(name)) {
    const hits = dangerTargetsOf(args, ctx, cwd);
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

// shell 解释器的 -c 载荷：支持组合短开关（bash -lc、sh -ec、zsh -ic）
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);

function shellDashCOf(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--' || t === '-' || t[0] !== '-') return null;
    if (/^-[A-Za-z]+$/.test(t) && t.slice(1).indexOf('c') >= 0) {
      return i + 1 < args.length ? args.slice(i + 1).join(' ') : null;
    }
    if (t === '-o' || t === '+o' || t === '-O' || t === '+O' ||
        t === '--rcfile' || t === '--init-file') i++; // 带独立值的开关跳过其值
  }
  return null;
}

/* ---- 远程代码执行形态（下载器 → shell / 进程替换 / eval） ---- */

const DOWNLOADERS = new Set(['curl', 'wget', 'aria2c', 'fetch']);
const STDIN_INTERPRETERS = new Set(['python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs', 'php']);
const RE_RCE_SUBST = /\b(?:bash|sh|zsh|dash|ksh|ash|source)\s+<\(\s*(?:curl|wget|aria2c|fetch)\b/;
const RE_RCE_DOT_SUBST = /(?:^|[\s;&|])\.\s+<\(\s*(?:curl|wget|aria2c|fetch)\b/;
const RE_RCE_EVAL = /\beval\s+["']?\$\(\s*(?:curl|wget|aria2c|fetch)\b/;

// 管道下游是否「直接执行 stdin」的 shell/解释器（bash -n 等语法检查形态放行）
function shellFromStdin(pc) {
  if (!pc) return false;
  if (SHELLS.has(pc.name)) {
    // 语法检查/帮助形态不执行 stdin；-c 形式执行参数而非 stdin；其余开关（-e/-x/--norc）
    // 仍会从 stdin 读脚本，必须继续判定。显式 -s 或没有脚本操作数 → 读 stdin。
    const args = pc.args;
    const low = args.map((a) => String(a).toLowerCase());
    if (low.some((a) => a === '-n' || a === '--noexec' || a === '--help' || a === '-h' ||
        a === '--version' || a === '-v' || a === '-V')) return false;
    if (low.some((a) => a === '-c' || /^-[A-Za-z]*c[A-Za-z]*$/.test(a))) return false;
    if (low.some((a) => a === '-s' || a === '--stdin')) return true;
    let script = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-o' || a === '+o' || a === '-O' || a === '+O' || a === '--rcfile' || a === '--init-file') { i++; continue; }
      if (a[0] !== '-') { script = a; break; }
    }
    return !script || script === '-' || script === '/dev/stdin';
  }
  if (STDIN_INTERPRETERS.has(pc.name)) {
    // 内联代码（-c/-e/-r/-m）或脚本文件不读 stdin；纯开关（-u/-B 等）仍读 stdin
    const args = pc.args.map((a) => String(a).toLowerCase());
    if (args.some((a) => a === '-c' || a === '-e' || a === '-r' || a === '-m' || a === '-p')) return false;
    const script = pc.args.find((a) => a[0] !== '-');
    return !script || script === '-' || script === '/dev/stdin';
  }
  return false;
}

function rceJudge(cmdStr, add) {
  if (RE_RCE_SUBST.test(cmdStr) || RE_RCE_DOT_SUBST.test(cmdStr)) {
    gateReason(add, '进程替换把下载内容直接交给 shell 执行', 'DG-RCE-SUBST');
  }
  if (RE_RCE_EVAL.test(cmdStr)) {
    gateReason(add, 'eval 直接执行下载内容', 'DG-RCE-EVAL');
  }
}

function isDownloaderCmd(pc) {
  return !!pc && DOWNLOADERS.has(pc.name);
}

// cmd /c、bash -c、wsl 等包装器解包；返回内层命令字符串，非包装器返回 null
function unwrapWrapper(name, args) {
  if (name === 'cmd') {
    const inner = args.filter((t) => !/^\/[cCkK]$/.test(t) && !/^-[cC]$/.test(t)).join(' ');
    return inner ? inner.replace(/^["']|["']$/g, '') : null;
  }
  if (SHELLS.has(name)) return shellDashCOf(args);
  if (name === 'wsl' || name === 'busybox') {
    const inner = args.join(' ');
    return inner || null;
  }
  // eval/trap 的载荷也是 shell 源码：照包装器解包递归判定（trap 'rm -rf /' EXIT）
  if (name === 'eval') {
    return args.join(' ') || null;
  }
  if (name === 'trap') {
    const action = args.find((t) => t[0] !== '-');
    return action || null; // trap -l 等纯开关形态无载荷
  }
  return null;
}

function psJudge(payload, ctx, depth, add, cwd) {
  if (depth > MAX_DEPTH || !payload) return;
  for (const sub of splitSegments(payload)) {
    if (ctx.cfg.enable_danger_gate) gateSegment(sub, ctx, depth + 1, add, cwd);
    if (ctx.cfg.enable_fence && ctx.projectDir) fenceSegment(sub, ctx, depth + 1, add, cwd);
  }
}

/* ================================================================
 * 解释器内嵌脚本载荷（node -e / python -c / perl -e / ruby -e / php -r / deno eval / awk …）
 *
 * 2026-09-28 真实触发：agent 用 node -e 的 fs.writeFileSync 改写
 * ~/.agents/.skill-lock.json，围栏因 node 不在写命令表而静默放行。
 * 启发式（与 psPayloadOf 对称，但不递归 shell 判定——载荷不是 shell 源码）：
 * 仅当「写 API 调用」与「绝对路径字面量」共现于同一载荷时，路径按写目标判。
 * 纯读/纯计算载荷零打扰；路径拼接、编码构造、child_process 属对抗性绕过，
 * 与 powershell -EncodedCommand 同态度：文档化盲区。
 * ================================================================ */

// 内嵌脚本开关（node 的 -p/--print 同样执行 JS）；perl/ruby/php 允许多次 -e/-r 拼接
const SCRIPT_RUNNERS = {
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  python: ['-c'], python3: ['-c'], python2: ['-c'],
  perl: ['-e'],
  ruby: ['-e'],
  php: ['-r'],
  osascript: ['-e'],
};
const AWK_NAMES = new Set(['awk', 'gawk', 'mawk', 'nawk']);

// -e/-c 紧随其后的一个参数是脚本本体；返回拼接载荷，非解释器返回 null
function scriptPayloadOf(name, args) {
  // deno eval <code>：子命令形态，代码在其后
  if (name === 'deno') {
    const i = args.findIndex((t) => t === 'eval');
    return i >= 0 && i + 1 < args.length ? args.slice(i + 1).join(' ') : null;
  }
  // awk 的程序是第一个非选项参数（-f 脚本文件属文档化盲区）
  if (AWK_NAMES.has(name)) {
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (t === '-f' || t === '--file') return null;
      if (t === '-v' || t === '--assign') { i++; continue; }
      if (t[0] === '-' && t.length > 1) continue;
      return t;
    }
    return null;
  }
  const switches = SCRIPT_RUNNERS[name];
  if (!switches) return null;
  const parts = [];
  for (let i = 0; i < args.length; i++) {
    if (switches.indexOf(args[i].toLowerCase()) >= 0 && i + 1 < args.length) {
      parts.push(args[i + 1]);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/* ---- 解释器 shell 执行载荷（system/exec/child_process/os.system/反引号…） ----
 * 只对「执行子进程」的 API 提取字符串参数并递归按 shell 命令判；
 * 纯读/纯计算载荷没有这些调用，保持沉默。
 */

const SHELL_EXEC_RES = {
  js: [
    /\bchild_process\s*\.\s*(?:exec|execSync|spawn|spawnSync|execFile|execFileSync|fork)\s*\(/gi,
    /\brequire\s*\(\s*['"]child_process['"]\s*\)\s*\.\s*\w+\s*\(/gi,
    /\b(?:execSync|execFileSync)\s*\(/g,
    /\bBun\s*\.\s*(?:spawn|spawnSync)\s*\(/gi,
    /\bDeno\s*\.\s*(?:Command|run)\s*\(/gi,
  ],
  python: [
    /\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*)\s*\(/gi,
    /\bsubprocess\s*\.\s*(?:run|call|Popen|check_output|check_call|getoutput|getstatusoutput)\s*\(/gi,
  ],
  perl: [/\b(?:system|exec|qx)\s*\(/gi],
  ruby: [/\b(?:system|exec|spawn)\s*\(/gi],
  php: [/\b(?:system|exec|shell_exec|passthru|popen|proc_open)\s*\(/gi],
  awk: [/\bsystem\s*\(/gi],
  osascript: [/\bdo\s+shell\s+script\b/gi],
};

// 读取起点处的字符串字面量（单/双/反引号），支持反斜杠转义
function readQuotedAt(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  let j = i + 1;
  let out = '';
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length) {
      const nx = s[j + 1];
      if (nx === q || nx === '\\') out += nx;
      else out += ch + nx;
      j += 2;
      continue;
    }
    if (ch === q) return { value: out, end: j + 1 };
    out += ch;
    j++;
  }
  return null;
}

// 读取调用第一个参数：字符串，或字符串数组（subprocess.run(["rm","-rf","/"])）
function readArgStringAt(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] === '[') {
    let j = i + 1;
    const parts = [];
    while (j < s.length && s[j] !== ']') {
      while (j < s.length && /[\s,]/.test(s[j])) j++;
      if (s[j] === ']') break;
      const got = readQuotedAt(s, j);
      if (!got) return null;
      parts.push(got.value);
      j = got.end;
    }
    return parts.length ? { value: parts.join(' '), end: j + 1 } : null;
  }
  return readQuotedAt(s, i);
}

function shellPayloadsOf(name, payload) {
  if (!payload) return [];
  const groups = [];
  if (name === 'node' || name === 'nodejs' || name === 'bun' || name === 'deno') groups.push(SHELL_EXEC_RES.js);
  else if (/^python/.test(name)) groups.push(SHELL_EXEC_RES.python);
  else if (name === 'perl') groups.push(SHELL_EXEC_RES.perl);
  else if (name === 'ruby') groups.push(SHELL_EXEC_RES.ruby);
  else if (name === 'php') groups.push(SHELL_EXEC_RES.php);
  else if (AWK_NAMES.has(name)) groups.push(SHELL_EXEC_RES.awk);
  else if (name === 'osascript') groups.push(SHELL_EXEC_RES.osascript);
  const out = [];
  const seen = new Set();
  const push = (v) => { if (v && v.trim() && !seen.has(v)) { seen.add(v); out.push(v); } };
  for (const res of groups) {
    for (const re of res) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(payload)) !== null) {
        const got = readArgStringAt(payload, m.index + m[0].length);
        if (got) push(got.value);
        if (re.lastIndex === m.index) re.lastIndex++; // 空匹配防死循环
      }
    }
  }
  // perl/ruby/php 的反引号载荷
  if (name === 'perl' || name === 'ruby' || name === 'php') {
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(payload)) !== null) push(m[1]);
  }
  return out;
}

// 解释器载荷：写 API 路径判定 + shell 执行载荷递归（两侧开关各自内部自查）
function interpreterJudge(name, payload, ctx, depth, add, cwd) {
  if (!payload) return;
  scriptJudge(payload, ctx, add, name);
  for (const p of shellPayloadsOf(name, payload)) {
    judgeCommand(p, ctx, depth + 1, add, cwd);
  }
}

// 载荷内写 API 形态（调用式，词边界 + 左括号防 from()/normal( 子串误配；
// destructuring 后的无前缀调用同样命中）。i 标志覆盖驼峰命名（writeFileSync）。
// JS 的 process.stdout.write 不在列（纯输出）。
const SCRIPT_WRITE_RES = [
  // JavaScript：fs / fsPromises 的写、删除、建目录
  /\bwritefilesync\s*\(/i, /\bwritefile\s*\(/i,
  /\bappendfilesync\s*\(/i, /\bappendfile\s*\(/i,
  /\brmsync\s*\(/i, /\brm\s*\(/i,
  /\bunlinksync\s*\(/i, /\bunlink\s*\(/i,
  /\brmdirsync\s*\(/i, /\brmdir\s*\(/i,
  /\brenamesync\s*\(/i, /\brename\s*\(/i,
  /\bcopyfilesync\s*\(/i, /\bcopyfile\s*\(/i,
  /\btruncatesync\s*\(/i, /\btruncate\s*\(/i,
  /\bmkdirsync\s*\(/i, /\bmkdir\s*\(/i,
  /\bcreatewritestream\s*\(/i, /\bwritesync\s*\(/i,
  // Python：open 写模式（'w'/'a'/'x'/'+'，纯读 'r'/'rb' 排除）、os / shutil / pathlib
  /\bopen\s*\([^)]*['"][rbt]*[wax+][rabt+]*['"]/i,
  /\bos\s*\.\s*(remove|unlink|rmdir|removedirs|rename|replace|truncate|mkdir|makedirs)\s*\(/i,
  /\bshutil\s*\.\s*(rmtree|copy|copy2|copyfile|copystat|copytree|move)\s*\(/i,
  /\bwrite_text\s*\(/i, /\bwrite_bytes\s*\(/i,
  // Ruby：File./FileUtils. 写形态（File.open(p,'w') 由上面的 open 规则覆盖）
  /\bfile\s*\.\s*(write|binwrite|delete|rename)\s*\(/i,
  /\bfileutils\s*\.\s*(rm\w*|mv\w*|cp\w*|install)\b/i,
  // Perl：双参 open 的写模式（'>'、'>>'、'+<'；纯读 '<' 排除）
  /\bopen\s*\(\s*[\w:]+\s*,\s*['"][+>]/i,
  // Perl：无括号 unlink "path" 形态
  /\bunlink\s+['"\/~$%]/i,
  // PHP：写文件 / 删除 / 改名 / 建目录（php -r 载荷）
  /\bfile_put_contents\s*\(/i,
  /\bfwrite\s*\(/i,
  /\bfopen\s*\([^)]*['"][wax+][a-z+]*['"]/i,
  /\bcopy\s*\(/i,
  // Deno：删除 / 写入 / 建目录（deno eval 载荷）
  /\bdeno\s*\.\s*(remove|removeSync|writeTextFile|writeTextFileSync|writeFile|writeFileSync|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync)\s*\(/i,
];

// 写 API 与绝对路径字面量共现 → 路径按写目标判（危险门 + 围栏两侧自查开关，
// gateSegment/fenceSegment 各调一次，add 去重；与 psJudge 模式一致）
function scriptJudge(payload, ctx, add, cmdLabel) {
  if (!payload) return;
  // tokenize 保留的 \" 归一为 "（路径内不会出现反斜杠紧邻引号，安全）。
  // \n \t \r 不归一：Windows 路径 \node、\tmp 的反斜杠是分隔符，展开会截断路径；
  // 宿主 JSON stdin 场景换行本就是真实换行，字面 \n 仅 --eval 调试语境出现
  payload = payload.replace(/\\"/g, '"');
  let hasWrite = false;
  for (const re of SCRIPT_WRITE_RES) {
    if (re.test(payload)) { hasWrite = true; break; }
  }
  if (!hasWrite) return;
  // 路径只从字符串字面量里提取：fs API 的真实写路径必在引号内（tokenize 保留了载荷内部
  // 的单双引号与反引号）；正则字面量 /.../ 无引号，不再被误当 Unix 绝对路径——
  // matchAll(/span_sec: (\d+)/)、split(/^## /m) 这类 JS 数据处理标配写法曾整批误报（2026-10-01）。
  // python 无正则字面量语法、路径本就在字符串里，提取结果与全文提取一致。
  const strToks = [];
  // 重复体必须用非捕获组（(?:...)）：捕获组放进 (A|B)* 里会被每次迭代重置，只留最后一个字符
  const RE_STR_LIT = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;
  let sm;
  while ((sm = RE_STR_LIT.exec(payload)) !== null) {
    for (const t of extractPathTokens(sm[0].slice(1, -1))) strToks.push(t);
  }
  for (const tok of strToks) {
    const info = normalizePath(tok, ctx.npBash);
    // 相对路径无法定归属（cwd 未知）不判；载荷内 $VAR/%VAR% 多为字面量，
    // 展开失败不追问（与 Bash 命令行 token 的保守追问口径不同，追问必误报）
    if (info.kind === 'null' || info.kind === 'relative' || info.kind === 'empty' ||
        info.kind === 'unresolved' || info.unresolved) continue;
    if (ctx.cfg.enable_danger_gate && isDangerTarget(info, ctx)) {
      gateReason(add, cmdLabel + ' 内嵌脚本写入灾难级目标 ' + info.norm, 'DG-SCRIPT-WRITE');
    }
    if (ctx.cfg.enable_fence && ctx.projectDir && !isInsideRoots(info.norm, ctx.roots, ctx.platform)) {
      add('[' + PLUGIN_ID + ': 越界写入] ' + cmdLabel + ' 内嵌脚本的写目标 ' + info.norm +
        ' 不在项目根 ' + ctx.projectDir + ' 等可写根内');
    }
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

function judgeWriteTarget(rawTok, ctx, cmdLabel, cwd) {
  const info = resolveTarget(rawTok, ctx, cwd);
  if (!info || info.kind === 'empty') return null; // 相对路径且 cwd 未知 → fail-open
  // 未定义变量（如 Unix 上的 %USERPROFILE%）→ 无法判定归属，宁可多问一句
  if (info.kind === 'unresolved' || info.unresolved) {
    return '[' + PLUGIN_ID + ': 路径无法解析] ' + rawTok + ' 含未定义变量，无法判定归属，请改用明确路径';
  }
  if (info.kind === 'null' || info.kind === 'relative') return null;
  if (!ctx.roots || !ctx.roots.length) return null; // ZCODE_PROJECT_DIR 缺失 → 围栏降级
  if (!isInsideRoots(info.norm, ctx.roots, ctx.platform)) {
    // 披露当前项目根：会话工作区开错层级时（如开在子目录）用户可一眼诊断
    return '[' + PLUGIN_ID + ': 越界写入] ' + cmdLabel + ' 的目标 ' + info.norm + ' 不在项目根 ' +
      ctx.projectDir + ' 等可写根内';
  }
  return null;
}

function fenceSegment(seg, ctx, depth, add, cwd) {
  if (depth > MAX_DEPTH) return;
  const targets = [];
  for (const t of extractRedirects(seg)) targets.push(t); // 重定向目标永远判

  const tokens = tokenize(seg);
  const pc = parseCmd(tokens);
  if (pc) {
    const name = pc.name;
    const args = pc.args;
    if (WRITE_ALL.has(name)) {
      // 只取内层命令的操作数：包装器选项（env -C /tmp）不是写目标
      for (const t of operandTokens(args)) targets.push(t);
    } else if (name === 'mv' || name === 'move') {
      // mv 同时判源和目标（移动=源删除+目标写入）；cp 仍只判目标
      for (const t of operandTokens(args)) targets.push(t);
    } else if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
      for (const t of metaOperands(name, args)) targets.push(t);
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
        const low = args[i].toLowerCase();
        if (flags.indexOf(low) >= 0 && i + 1 < args.length) targets.push(args[i + 1]);
        for (const f of flags) {
          if (f.slice(0, 2) === '--' && low.indexOf(f + '=') === 0) targets.push(args[i].slice(f.length + 1));
        }
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
      if (payload) psJudge(payload, ctx, depth, add, cwd); // gate 关闭时围栏侧也兜底判一次
      return;
    }
    if (name === 'find' || name === 'sed' || name === 'gsed') {
      // gate 启用时 gateSegment 已调用（内部同时覆盖围栏）；仅在 gate 关闭时由围栏兜底。
      // 不提前 return：外层重定向目标（find … > 界外路径）照常落到尾部判定。
      if (!ctx.cfg.enable_danger_gate) {
        if (name === 'find') findJudge(args, ctx, depth, add, cwd);
        else sedJudge(args, ctx, add, cwd);
      }
    } else {
      // 解释器内嵌脚本：写 API 与路径字面量共现才判（gate 关闭时围栏侧也兜底判一次）。
      // 不提前 return：外层重定向目标（node -e "..." > 界外路径）照常落到尾部判定
      const script = scriptPayloadOf(name, args);
      if (script != null) {
        interpreterJudge(name, script, ctx, depth, add, cwd);
      } else {
        const inner = unwrapWrapper(name, args);
        if (inner != null) {
          judgeCommand(inner, ctx, depth + 1, add, cwd);
          return;
        }
      }
    }
  }

  for (const t of targets) {
    const label = pc ? pc.name : '重定向';
    const r = judgeWriteTarget(t, ctx, label, cwd);
    if (r) add(r);
  }
}

/* ================================================================
 * 命令级入口 / 文件工具入口 / 上下文
 * ================================================================ */

// 命令替换载荷：$(…) 与 `…`（单层提取；嵌套由递归 depth 兜底，不平衡场景 fail-open）
const RE_CMDSUB = /\$\(([^()]{1,2000})\)|`([^`]{1,2000})`/g;

// 命令内 cd / pushd / popd 状态：同一段命令里的后续段按更新后的 cwd 解析相对路径
function cdTargetOf(pc) {
  if (pc.name === 'popd') return { op: 'pop' };
  const target = operandTokens(pc.args)[0] || '';
  if (pc.name === 'pushd') {
    if (!target || /^[+-]\d+$/.test(target)) return { op: 'unknown' }; // 栈交换无法静态跟踪
    return { op: 'push', target };
  }
  if (!target) return { op: 'set', target: '~' }; // 裸 cd 回 home
  if (target === '-') return { op: 'unknown' };   // cd - 回上一个目录，无法静态跟踪
  return { op: 'set', target };
}

function applyCd(pc, ctx, state) {
  if (pc.name !== 'cd' && pc.name !== 'pushd' && pc.name !== 'popd') return;
  const c = cdTargetOf(pc);
  if (c.op === 'pop') { state.cwd = state.stack.length ? state.stack.pop() : null; return; }
  if (c.op === 'unknown') { state.cwd = null; return; }
  if (c.op === 'push') state.stack.push(state.cwd);
  const info = normalizePath(c.target, ctx.npBash);
  if (info.kind === 'relative') {
    const r = resolveAgainstCwd(info, state.cwd, ctx);
    state.cwd = r ? r.norm : null;
  } else if (info.kind === 'drive' || info.kind === 'unix' || info.kind === 'unc') {
    state.cwd = info.norm;
  } else {
    state.cwd = null;
  }
}

function judgeCommand(cmd, ctx, depth, add, cwd) {
  if (depth > MAX_DEPTH) return;
  const cmdStr = String(cmd == null ? '' : cmd);
  if (!cmdStr.trim()) return;
  const state = { cwd: cwd === undefined ? (ctx.cwd || null) : cwd, stack: [] };

  // $()/反引号内嵌命令先行提取递归判定（echo $(rm -rf /)）；外层命令照常分段。
  // 先收集完再递归：RE_CMDSUB 是全局正则，边扫边递归会被子调用重置 lastIndex 造成死循环
  const subs = [];
  RE_CMDSUB.lastIndex = 0;
  let m;
  while ((m = RE_CMDSUB.exec(cmdStr)) !== null) {
    const body = m[1] != null ? m[1] : m[2];
    if (body && body.trim()) subs.push(body);
  }
  for (const sub of subs) judgeCommand(sub, ctx, depth + 1, add, state.cwd);

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
    rceJudge(cmdStr, add);
  }

  let prevPc = null;
  let pipeTainted = false; // 同一管道链里出现过下载器
  for (const part of splitSegmentsWithOps(cmdStr)) {
    const seg = part.seg;
    const pc = parseCmd(tokenize(seg));
    if (part.op === '|') {
      if (isDownloaderCmd(prevPc)) pipeTainted = true;
      if (pipeTainted && shellFromStdin(pc) && ctx.cfg.enable_danger_gate) {
        gateReason(add, '下载内容直接管道给 ' + pc.name + ' 执行', 'DG-RCE-PIPE');
      }
    } else {
      pipeTainted = false;
    }
    if (pc) applyCd(pc, ctx, state);
    if (ctx.cfg.enable_danger_gate) gateSegment(seg, ctx, depth, add, state.cwd);
    if (ctx.cfg.enable_fence && ctx.projectDir) fenceSegment(seg, ctx, depth, add, state.cwd);
    prevPc = pc;
  }
}

function judgeFileTool(toolName, target, ctx, add) {
  if (!ctx.cfg.enable_fence || !ctx.projectDir) return;
  let info = normalizePath(target, ctx.npFile);
  if (info.kind === 'empty') return;
  // 未定义变量优先判定（相对路径拼接前），与 Bash 侧口径一致
  if (info.kind === 'unresolved' || info.unresolved) {
    add('[' + PLUGIN_ID + ': 路径无法解析] ' + target + ' 含未定义变量，无法判定归属');
    return;
  }
  if (info.kind === 'relative') {
    // 文件工具目标理论上总是绝对路径；万一相对，按项目根解析后再判
    const sep = ctx.platform === 'win32' ? '\\' : '/';
    info = normalizePath(ctx.projectDir + sep + info.norm, ctx.npFile);
  }
  if (info.kind === 'null' || info.kind === 'relative' || info.kind === 'empty') return;
  if (!isInsideRoots(info.norm, ctx.roots, ctx.platform)) {
    // 披露当前项目根：会话工作区开错层级时（如开在子目录）用户可一眼诊断
    add('[' + PLUGIN_ID + ': 越界写入] ' + (toolName || 'Write') + ' 目标 ' + info.norm + ' 不在项目根 ' + ctx.projectDir + ' 等可写根内');
  }
}

/* ================================================================
 * 会话根锁定（lock_session_root，2026-09-29）
 *
 * 实测宿主行为：ZCODE_PROJECT_DIR 跟随 Bash 持久 cwd——agent cd 进子目录后，
 * 后续所有调用（含 Write/Edit）注入的项目根一起漂移。后果：cd 进子目录 →
 * 写真正项目根被误报（vedio 案例 2026-09-28）；cd 出项目 → 围栏整段失效。
 * 对策：stdin 载荷带 session_id，插件数据目录存「会话 → 首见根」单文件映射，
 * 每会话仅首见时写一行，之后纯读；判定永远按首见根（≈会话初始 cwd ≈ 工作区根）。
 * fail-open：读不了 / 坏行 / 无 session_id / 写失败 → 当首次或按注入根判定，不崩溃。
 * 已知取舍：会话中途真换工作区会按旧根持续 ask（用户 2026-09-29 确认接受）。
 * ================================================================ */

const SESSION_ROOTS_FILE = 'session-roots.log';
const SESSION_ROOTS_MAX = 200;                      // 条目上限，写入时顺带截断（单文件 ≤20KB 有上界）
const SESSION_ROOTS_TTL_MS = 30 * 24 * 3600 * 1000; // 条目过期，会话不可能存活更久
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;     // session_id 作状态键前的合法性校验

function sessionRootsFile(env) {
  return path.join(dataDir(env), SESSION_ROOTS_FILE);
}

// 读「会话 → 首见根」映射；坏行隔离；读失败返回空表（当全部首见）
function loadSessionRoots(env) {
  let raw = '';
  try { raw = fs.readFileSync(sessionRootsFile(env), 'utf8'); } catch (e) { return {}; }
  const out = {};
  for (const line of String(raw).split('\n')) {
    const t = line.split('\t');
    if (t.length < 3 || !SESSION_ID_RE.test(t[0]) || !t[1]) continue;
    out[t[0]] = { root: t[1], ts: Date.parse(t[2]) || 0 };
  }
  return out;
}

// 记录首见根并顺带清理（过期/超额删最旧）。写前重读合并其他进程新写的条目，
// 把并发丢条目窗口压到最小；残余竞态的后果只是该会话下次重新首见（fail-open）。
function saveSessionRoot(env, sessionId, rootNorm) {
  try {
    const file = sessionRootsFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = Date.now();
    const merged = loadSessionRoots(env);
    merged[sessionId] = { root: rootNorm, ts: now };
    const entries = Object.keys(merged)
      .filter((sid) => now - merged[sid].ts < SESSION_ROOTS_TTL_MS)
      .sort((a, b) => merged[a].ts - merged[b].ts)
      .slice(-SESSION_ROOTS_MAX);
    fs.writeFileSync(file, entries
      .map((sid) => [sid, merged[sid].root, new Date(merged[sid].ts).toISOString()].join('\t'))
      .join('\n') + '\n');
  } catch (e) { /* 状态写失败不影响判定 */ }
}

function buildContext(env, opts) {
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
      // 会话根锁定：ZCODE_PROJECT_DIR 跟随 Bash 持久 cwd、cd 即漂移（2026-09-29 实测），
      // 按 session 首见根判定、漂移被忽略；首见 ≈ 会话初始 cwd ≈ 工作区根
      const sid = opts && opts.sessionId;
      if (loaded.cfg.lock_session_root && typeof sid === 'string' && SESSION_ID_RE.test(sid)) {
        const locked = loadSessionRoots(env)[sid];
        if (locked && locked.root && locked.root !== projectDir) {
          loaded.notes.push('项目根漂移：注入 ' + projectDir + ' 与会话首见根 ' + locked.root + ' 不一致，按首见根判定');
          projectDir = locked.root;
        } else if (!locked) {
          saveSessionRoot(env, sid, projectDir);
        }
      }
    }
  }

  const homeInfo = normalizePath(homeOf(env), npBash);
  const homeNorm = (homeInfo.kind === 'drive' || homeInfo.kind === 'unix') ? homeInfo.norm : '';

  const ctx = {
    cfg: loaded.cfg, cfgPath: loaded.cfgPath, notes: loaded.notes,
    platform, env, projectDir, homeNorm, npFile, npBash, roots: null,
  };

  if (projectDir) {
    // 可写根 = 项目根 + 当前平台真实临时目录 + ZCode 项目记忆目录 + 用户配置的额外可写根。
    // 相对写目标按命令内 cwd 解析后同样与这些根比较（cd 进临时目录后的相对写仍放行）。
    const roots = [projectDir];
    const temps = platform === 'win32'
      ? [env.TEMP, env.TMP, os.tmpdir()]     // Windows 读 TEMP/TMP（真实临时目录）
      : [env.TMPDIR, '/tmp', os.tmpdir()];   // Unix 用 TMPDIR，/tmp 保留
    // ZCode 项目记忆目录（~/.zcode/cli/memories）：宿主记忆功能高频写入，默认放行，
    // 避免完全访问模式下反复弹确认。用正斜杠 join，兼容 HOME 为 MSYS 风格（/c/Users/x）的环境。
    const memRoot = [homeOf(env), '.zcode', 'cli', 'memories'].join('/');
    const extras = splitList(ctx.cfg.extra_writable_roots);
    for (const t of temps.concat([memRoot], extras)) {
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
  const ctx = buildContext(env, { sessionId: p && p.session_id });
  const reasons = [];
  const add = (r) => { if (reasons.indexOf(r) < 0) reasons.push(r); };
  const tool = String((p && p.tool_name) || '');
  const ti = (p && p.tool_input) || {};
  let detail = '';

  // 宿主注入的当前目录（Bash 的持久 cwd）：命令内 cd 的起点，用于解析相对写目标。
  // 只认载荷（--eval 调试不带 cwd → 相对路径保持 fail-open 放行，与 v1.3.x 一致）。
  if (p && typeof p.cwd === 'string' && p.cwd) {
    const ci = normalizePath(p.cwd, ctx.npFile);
    if (ci.kind === 'drive' || ci.kind === 'unix' || ci.kind === 'unc') ctx.cwd = ci.norm;
  }
  ctx.cwd = ctx.cwd || null;

  if (/^bash$/i.test(tool)) {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    detail = cmd;
    judgeCommand(cmd, ctx, 0, add, ctx.cwd);
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

// 决策日志目录优先级：ZCODE_FENCE_DATA_DIR（测试注入）> ZCODE_PLUGIN_DATA（宿主注入，
// 指向 <id>@<市场名> 的权威目录）> 扫描 data 目录（@市场 目录优先）> 裸 <id> 兜底。
function dataDir(env) {
  if (env.ZCODE_FENCE_DATA_DIR) return env.ZCODE_FENCE_DATA_DIR;
  const base = path.join(homeOf(env), '.zcode', 'cli', 'plugins', 'data');
  if (env.ZCODE_PLUGIN_DATA) return env.ZCODE_PLUGIN_DATA;
  try {
    const withMarket = fs.readdirSync(base)
      .filter((n) => n.indexOf(PLUGIN_ID + '@') === 0).sort();
    if (withMarket.length) return path.join(base, withMarket[0]);
    if (fs.existsSync(path.join(base, PLUGIN_ID))) return path.join(base, PLUGIN_ID);
  } catch (e) { /* data 目录不存在则落回裸 id */ }
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

/* ================================================================
 * 可选决策模型审核层（默认关闭）
 *
 * 只在确定性两层都 silent 时调用：一次请求五问（四个风险维度 + 执行诊断）；
 * 模型只能产生 ask 或沉默。超时/网络错误/非法响应/未配置端点一律 fail-open
 * 并写入决策日志。零依赖（Node 内置 http/https/tls），Node 16 兼容。
 * ================================================================ */

const MODEL_MAX_INPUT_CHARS = 2000;
const OPAQUE_THRESHOLD = 0.70;        // 执行诊断阈值，不随严格度变化
const MODEL_POLICY_HINT = 'Apply state.policy if present.';

// 四个硬维度：数组顺序 = 并列时的 scope 优先级（高 → 低）
const MODEL_HARD_DIMENSIONS = [
  { key: 'q_exfil', kind: 'exfiltration', scope: 4 },
  { key: 'q_external', kind: 'external_side_effect', scope: 3 },
  { key: 'q_loss', kind: 'irreversible_loss', scope: 2 },
  { key: 'q_system', kind: 'system_change', scope: 1 },
];

// 内置五问：问题名、语义与 criteria 见 spec 附录 A；q_opaque 只做诊断
const MODEL_QUESTIONS = {
  q_loss: {
    instructions: 'Could this call delete, overwrite, or corrupt data that cannot be easily ' +
      'recovered? True examples: git reset --hard, git clean -fdx, docker compose down -v ' +
      '(deletes named volumes), aws s3 rm --recursive, DROP TABLE, overwriting a database or ' +
      'backup. False examples: removing build/, dist/, node_modules/, or a cache directory.',
    criteria: {
      true: 'Yes: it destroys untracked or uncommitted work, databases, backups, remote objects, ' +
        'volumes, or git history, or overwrites files with no easy undo.',
      false: 'No: it only removes disposable build output or cache, or does not delete or ' +
        'overwrite meaningful data.',
    },
  },
  q_system: {
    instructions: 'Does this call change machine-wide or user-wide system state, services, ' +
      'persistence, storage, or installed packages? A global package-manager install ' +
      '(npm install -g, pip install --user, brew/winget/choco/apt/scoop install) is ' +
      'system-level even if the package is a dev tool.',
    criteria: {
      true: 'Installs or removes global packages, edits system or shell config, manages ' +
        'services/startup/cron, partitions or mounts disks, or changes firewall/routing/drivers.',
      false: 'Only touches project-local dependencies (node_modules, .venv), project files, ' +
        'or disposable caches.',
    },
  },
  q_external: {
    instructions: 'Does this call cause an external side effect that is hard to undo? True ' +
      'examples: npm publish, gh release create, git push --force/--mirror/--delete, aws s3 rm, ' +
      'curl -X DELETE/POST/PUT/PATCH, scp upload, deployment. False examples: local ' +
      'rm/del/cp/mv, npm install, docker build/pull, curl -s URL (a GET), gh pr view/list, ' +
      'normal git push, requests to localhost.',
    criteria: {
      true: 'Publishes, deploys, force/mirror/delete pushes, deletes or overwrites remote ' +
        'resources, uploads data, or sends POST/PUT/PATCH/DELETE to a remote service.',
      false: 'Local filesystem operations; dependency or base-image downloads; a curl/wget/gh ' +
        'command that only fetches (GET/HEAD, view/list); normal git push of new commits; ' +
        'localhost or a local dev server.',
    },
  },
  q_exfil: {
    instructions: 'Does this call send credentials, secrets, private keys, or private user data ' +
      'off the machine?',
    criteria: {
      true: 'Uploads or posts .env files, keys, tokens, or private files; pipes them to a ' +
        'network tool; or embeds them in a URL or request body.',
      false: 'No secret or private user data leaves the machine; a plain public GET is not ' +
        'exfiltration.',
    },
  },
  q_opaque: {
    instructions: 'Does this call execute code whose full behavior is not visible in the ' +
      'command (an interpreter, script, test runner, container, or binary)? Diagnostic only; ' +
      'answer factually.',
    criteria: {
      true: 'Runs an interpreter, script, test runner, container, or binary; the full behavior ' +
        'is not visible in the command.',
      false: 'Only reads or writes files, or runs a command that does not execute project code.',
    },
  },
};

// 严格度预设：设置界面只暴露 0/1/2 一个数字档位，四个阈值不单独配置
const STRICTNESS_PRESETS = {
  0: { q_loss: 0.70, q_system: 0.65, q_external: 0.75, q_exfil: 0.75 },
  1: { q_loss: 0.80, q_system: 0.75, q_external: 0.85, q_exfil: 0.85 },
  2: { q_loss: 0.85, q_system: 0.80, q_external: 0.90, q_exfil: 0.90 },
};
const DEFAULT_STRICTNESS = 1;

function isLocalAddress(host) {
  let h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;              // IPv4 link-local
  if (/^f[cd][0-9a-f]{0,2}:/i.test(h)) return true;     // IPv6 ULA
  if (/^fe[89ab][0-9a-f]{0,2}:/i.test(h)) return true;  // IPv6 link-local
  return false;
}

// 端点必须 https，或本机/私网 http（非法端点拒绝调用并 fail-open）
function parseModelEndpoint(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw)); } catch (e) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.protocol === 'http:' && !isLocalAddress(u.hostname)) return null;
  return u;
}

function noProxyMatches(host, noProxy) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of String(noProxy || '').split(',')) {
    let t = raw.trim().toLowerCase();
    if (!t) continue;
    if (t === '*') return true;
    t = t.replace(/^\./, '');
    const hp = t.indexOf(':') >= 0 ? t.split(':')[0] : t;
    if (h === hp || h.endsWith('.' + hp)) return true;
  }
  return false;
}

// 代理优先级：配置 > 环境（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）；本机端点与 NO_PROXY 直连
function resolveProxy(endpoint, cfg, env) {
  if (isLocalAddress(endpoint.hostname)) return { url: null, error: null };
  const noProxy = env.NO_PROXY || env.no_proxy || '';
  if (noProxyMatches(endpoint.hostname, noProxy)) return { url: null, error: null };
  const raw = cfg.decision_model_proxy ||
    (endpoint.protocol === 'https:'
      ? (env.HTTPS_PROXY || env.https_proxy)
      : (env.HTTP_PROXY || env.http_proxy)) ||
    env.ALL_PROXY || env.all_proxy || '';
  if (!raw) return { url: null, error: null };
  let p;
  try { p = new URL(String(raw)); } catch (e) { return { url: null, error: '代理地址非法' }; }
  if (p.protocol !== 'http:') return { url: null, error: '仅支持 http:// 代理' };
  return { url: p, error: null };
}

// 发送前脱敏：API key/token/password/Authorization/私钥块/长密钥；默认不发送文件内容
function sanitizeModelInput(text, apiKey) {
  let s = String(text == null ? '' : text);
  if (apiKey) s = s.split(String(apiKey)).join('[REDACTED]');
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]');
  s = s.replace(/\b(Bearer)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 [REDACTED]');
  s = s.replace(/\b(api[_-]?key|token|password|passwd|pwd|secret|access[_-]?key|secret[_-]?key|client[_-]?secret|authorization)\b(\s*[:=]\s*)(['"]?)[^\s'";,]{3,}\3/gi,
    '$1$2$3[REDACTED]$3');
  // 长密钥：32 位以上的 hex 串或含数字的长 token（git SHA、base64 密钥等）
  s = s.replace(/\b[A-Za-z0-9_\-]{32,}={0,2}\b/g, (m) => {
    const core = m.replace(/=+$/, '');
    return /^[0-9a-f]+$/i.test(core) || /\d/.test(core) ? '[REDACTED]' : m;
  });
  return s;
}

// headers 配置：分号分隔的 "Name: Value"（设置界面单行输入）
function parseModelHeaders(s) {
  const out = {};
  for (const part of splitList(s)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// 单个 noul 答案的分数：兼容 noul / probability / score，非有限数值视为缺失
function noulScore(answer) {
  if (answer == null) return null;
  if (typeof answer === 'number') return isFinite(answer) ? answer : null;
  if (typeof answer !== 'object' || Array.isArray(answer)) return null;
  const raw = answer.noul != null ? answer.noul
    : (answer.probability != null ? answer.probability : answer.score);
  if (raw == null) return null;
  const n = Number(raw);
  return isFinite(n) ? n : null;
}

// 解析 B5 五问答案：四个硬维度必须齐全；q_opaque 可选（缺失不影响裁决）
function parseModelAnswers(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '响应缺少 answers' };
  const answers = body.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { error: '响应缺少 answers' };
  const scores = {};
  for (const key of Object.keys(MODEL_QUESTIONS)) {
    if (key === 'q_opaque') continue;
    const v = noulScore(answers[key]);
    if (v == null) return { error: '响应缺少 answers.' + key };
    scores[key] = v;
  }
  const opaque = noulScore(answers.q_opaque);
  return { scores, opaque, opaqueMissing: opaque == null };
}

/**
 * 本地裁决：任一硬维度 score >= threshold → ask；kind 取跨阈值维度中
 * margin（score - threshold）最大者，margin 并列按 scope 从高到低，再按固定顺序。
 * 无跨阈值时用 q_opaque >= 0.70 区分 code_execution / routine。
 */
function decideModelAnswers(scores, opaque, thresholds) {
  const margins = {};
  const crossed = [];
  MODEL_HARD_DIMENSIONS.forEach((dim, order) => {
    const threshold = thresholds[dim.key];
    const margin = scores[dim.key] - threshold;
    margins[dim.key] = margin;
    if (scores[dim.key] >= threshold) {
      crossed.push({
        q: dim.key, kind: dim.kind, scope: dim.scope, order,
        score: scores[dim.key], threshold, margin,
      });
    }
  });
  const crossedKinds = crossed.map((x) => x.kind);
  if (!crossed.length) {
    const kind = (opaque != null && opaque >= OPAQUE_THRESHOLD) ? 'code_execution' : 'routine';
    return { kind, trigger: null, thresholds, margins, crossed: crossedKinds };
  }
  const maxMargin = Math.max.apply(null, crossed.map((x) => x.margin));
  const tied = crossed.filter((x) => maxMargin - x.margin <= 1e-9);
  tied.sort((a, b) => (b.scope - a.scope) || (a.order - b.order));
  return { kind: tied[0].kind, trigger: tied[0], thresholds, margins, crossed: crossedKinds };
}

function modelQuestions() {
  const out = {};
  for (const key of Object.keys(MODEL_QUESTIONS)) {
    const q = MODEL_QUESTIONS[key];
    out[key] = {
      type: 'noul',
      instructions: q.instructions,
      criteria: { true: q.criteria.true, false: q.criteria.false },
    };
  }
  return out;
}

/**
 * 发起一次 HTTP POST（JSON）。proxy 非空时走 http 代理（https 目标用 CONNECT 隧道）。
 * 回调 cb(err, statusCode, text)；超时/错误由内部定时器与 socket 销毁兜底。
 */
function httpPostJson(endpoint, proxy, extraHeaders, bodyObj, timeoutMs, cb) {
  const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  const headers = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, extraHeaders);
  let finished = false;
  const sockets = [];
  let timer = null;
  const done = (err, status, text) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    for (const s of sockets) { try { s.destroy(); } catch (e) { /* 已关闭 */ } }
    cb(err, status, text);
  };
  timer = setTimeout(() => done(new Error('超时')), timeoutMs);

  const targetHost = endpoint.hostname.replace(/^\[|\]$/g, '');
  const targetPort = endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80);
  const targetPath = (endpoint.pathname || '/') + (endpoint.search || '');

  const onResponse = (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { if (text.length < 65536) text += d; });
    res.on('end', () => done(null, res.statusCode, text));
    res.on('error', done);
  };

  if (!proxy) {
    const mod = endpoint.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: targetHost, port: targetPort, path: targetPath, method: 'POST',
      headers, agent: false,
    }, onResponse);
    req.on('socket', (s) => sockets.push(s));
    req.on('error', done);
    req.end(payload);
    return;
  }

  const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = proxy.port || 80;
  if (endpoint.protocol === 'http:') {
    const req = http.request({
      hostname: proxyHost, port: proxyPort, path: endpoint.href, method: 'POST',
      headers: Object.assign({ Host: endpoint.host }, headers), agent: false,
    }, onResponse);
    req.on('socket', (s) => sockets.push(s));
    req.on('error', done);
    req.end(payload);
    return;
  }

  // https 目标经 HTTP 代理：CONNECT 隧道后在该 socket 上做 TLS
  const authority = targetHost + ':' + targetPort;
  const creq = http.request({
    hostname: proxyHost, port: proxyPort, method: 'CONNECT', path: authority,
    headers: { Host: authority }, agent: false,
  });
  creq.on('socket', (s) => sockets.push(s));
  creq.on('error', done);
  creq.on('connect', (res, socket) => {
    sockets.push(socket);
    if (res.statusCode !== 200) { done(new Error('代理 CONNECT ' + res.statusCode)); return; }
    const tlsSock = tls.connect({ socket, servername: targetHost }, () => {
      const agent = new https.Agent({ keepAlive: false, createConnection: () => tlsSock });
      const req = https.request({
        hostname: targetHost, port: targetPort, path: targetPath, method: 'POST',
        headers, agent,
      }, onResponse);
      req.on('error', done);
      req.end(payload);
    });
    sockets.push(tlsSock);
    tlsSock.on('error', done);
  });
  creq.end();
}

async function decisionModelJudge(payload, judged, env) {
  const cfg = judged.ctx.cfg;
  const strictness = DEFAULT_STRICTNESS;
  const thresholds = STRICTNESS_PRESETS[strictness];
  const rec = {
    enabled: true, invoked: false, model: cfg.decision_model_model || '',
    outcome: 'skipped', strictness,
  };
  const fail = (why) => {
    rec.outcome = 'fail-open';
    rec.error = why;
    return { reason: null, record: rec };
  };
  const endpoint = parseModelEndpoint(cfg.decision_model_endpoint);
  if (!cfg.decision_model_endpoint) return fail('端点未配置');
  if (!endpoint) return fail('端点非法（必须是 https，或本机/私网 http）');
  const proxy = resolveProxy(endpoint, cfg, env);
  if (proxy.error) return fail(proxy.error);

  const apiKey = env.ZCODE_FENCE_DECISION_MODEL_API_KEY ||
    env.DECISION_MODEL_API_KEY || cfg.decision_model_api_key || '';
  const headers = parseModelHeaders(cfg.decision_model_headers);
  if (apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
    headers.Authorization = 'Bearer ' + apiKey;
  }
  let input = sanitizeModelInput(judged.detail, apiKey);
  if (input.length > MODEL_MAX_INPUT_CHARS) input = input.slice(0, MODEL_MAX_INPUT_CHARS) + '…';
  const body = {
    state: {
      tool: judged.tool || 'unknown',
      input,
      project_root: judged.ctx.projectDir || '',
    },
    questions: modelQuestions(),
  };
  // 当前目录只在能归一为绝对路径时发送；可写根仅在非空时发送
  if (judged.ctx.cwd) body.state.cwd = judged.ctx.cwd;
  if (judged.ctx.roots && judged.ctx.roots.length) body.state.allowed_roots = judged.ctx.roots.slice();
  if (cfg.decision_model_model) body.model = cfg.decision_model_model;

  rec.invoked = true;
  rec.endpoint_host = endpoint.host;
  const start = Date.now();
  const resp = await new Promise((resolve) => {
    httpPostJson(endpoint, proxy.url, headers, body, cfg.decision_model_timeout_ms,
      (err, status, text) => resolve({ err, status, text }));
  });
  rec.elapsed_ms = Date.now() - start;
  if (resp.err) return fail(resp.err.message || String(resp.err));
  if (resp.status < 200 || resp.status >= 300) return fail('HTTP ' + resp.status);
  let parsed;
  try { parsed = JSON.parse(resp.text); } catch (e) { return fail('响应不是合法 JSON'); }
  const ans = parseModelAnswers(parsed);
  if (ans.error) return fail(ans.error);
  rec.scores = Object.assign({}, ans.scores, { q_opaque: ans.opaque });
  rec.thresholds = thresholds;
  rec.opaque_missing = ans.opaqueMissing;
  const decision = decideModelAnswers(ans.scores, ans.opaque, thresholds);
  rec.kind = decision.kind;
  rec.margins = decision.margins;
  rec.crossed = decision.crossed;
  if (decision.trigger) {
    const t = decision.trigger;
    rec.outcome = 'ask';
    return {
      reason: '[' + PLUGIN_ID + ': 决策模型] 建议确认：' + decision.kind +
        '（' + t.q + ' ' + t.score.toFixed(2) + ' ≥ ' + t.threshold.toFixed(2) +
        '；strictness=' + strictness + '）',
      record: rec,
    };
  }
  rec.outcome = 'silent';
  return { reason: null, record: rec };
}

/**
 * 异步版核心执行：确定性层 silent 且启用决策模型时，多问一次模型。
 * 任何失败都不影响确定性层结论（fail-open）。
 */
async function runGuardAsync(stdinText, env, source) {
  let payload = null;
  let parseErr = null;
  try { payload = JSON.parse(stdinText); } catch (e) { parseErr = e; }

  if (parseErr) {
    const rec = { source, level: 'error', verdict: 'error', note: 'stdin 非法 JSON: ' + parseErr.message, stdin: snippet(stdinText) };
    return { out: '', record: rec };
  }
  try {
    const r = judgePayload(payload, env);
    const reasons = r.reasons.slice();
    let dmRecord = null;
    if (!reasons.length && r.ctx.cfg.enable_decision_model &&
        /^(bash|write|edit|applypatch)$/i.test(r.tool)) {
      const dm = await decisionModelJudge(payload, r, env);
      if (dm.reason) reasons.push(dm.reason);
      dmRecord = dm.record;
    }
    const rec = {
      source, level: 'info',
      verdict: reasons.length ? 'ask' : 'silent',
      tool: r.tool, detail: snippet(r.detail),
      reasons,
      project_dir: r.ctx.projectDir || '',
      config_notes: r.ctx.notes,
    };
    if (dmRecord) rec.decision_model = dmRecord;
    return { out: reasons.length ? askJson(reasons) : '', record: rec };
  } catch (e) {
    const rec = { source, level: 'error', verdict: 'error', note: '内部异常: ' + ((e && e.stack) || e) };
    return { out: '', record: rec }; // fail-open
  }
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
  'zcode-fence —— ZCode 确定性围栏插件（危险命令门 + 项目围栏 + 可选决策模型审核）',
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
  '  ZCODE_FENCE_DECISION_MODEL_API_KEY 决策模型 key（优先于配置）',
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
    return Promise.resolve();
  }
  if (argv[0] === '--eval' || argv[0] === '--eval-write' || argv[0] === '--eval-edit') {
    const target = argv.slice(1).join(' ');
    const payload = argv[0] === '--eval'
      ? { tool_name: 'Bash', tool_input: { command: target } }
      : { tool_name: argv[0] === '--eval-write' ? 'Write' : 'Edit', tool_input: { file_path: target } };
    return runGuardAsync(JSON.stringify(payload), process.env, 'eval').then((r) => {
      writeLog(r.record, process.env, loadConfig(process.env).cfg.enable_log); // 日志开关与 hook 模式一致
      process.stdout.write(r.out);
      evalSummary(r.record);
    });
  }
  // hook 模式
  return new Promise((resolve) => {
    readAllStdin((text) => {
      runGuardAsync(text, process.env, 'hook').then((r) => {
        const logEnabled = loadConfig(process.env).cfg.enable_log;
        writeLog(r.record, process.env, logEnabled);
        process.stdout.write(r.out);
        resolve();
      });
    });
  });
}

module.exports = {
  PLUGIN_ID,
  DEFAULT_CONFIG,
  normalizePath,
  expandVars,
  splitSegments,
  splitSegmentsWithOps,
  tokenize,
  parseCmd,
  extractPathTokens,
  extractRedirects,
  scriptPayloadOf,
  isUnder,
  isInsideRoots,
  realPathBest,
  isDangerTarget,
  loadConfig,
  splitList,
  dataDir,
  loadSessionRoots,
  saveSessionRoot,
  buildContext,
  judgeCommand,
  judgeFileTool,
  judgeWriteTarget,
  gateSegment,
  fenceSegment,
  judgePayload,
  runGuard,
  runGuardAsync,
  decisionModelJudge,
  sanitizeModelInput,
  parseModelEndpoint,
  parseModelAnswers,
  decideModelAnswers,
  modelQuestions,
  STRICTNESS_PRESETS,
  DEFAULT_STRICTNESS,
  parseModelHeaders,
  resolveProxy,
  isLocalAddress,
  gitDisposition,
};

if (require.main === module) {
  // fail-open：CLI 层的意外异常也不能以非零码结束或卡住 hook，但异常仍要写决策日志
  main().catch((e) => {
    try {
      writeLog({
        source: 'cli', level: 'error', verdict: 'error',
        note: 'CLI 异常: ' + ((e && e.stack) || e),
      }, process.env, loadConfig(process.env).cfg.enable_log);
    } catch (err) { /* 日志失败不影响 fail-open */ }
  });
}
