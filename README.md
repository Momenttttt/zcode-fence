# zcode-fence

**简体中文** ｜ [English](README_EN.md)

**ZCode 确定性围栏插件：危险命令门 + 项目围栏。Windows 一等公民，三平台可用，ask-only，零依赖（Node ≥ 16）。**

日常开着「完全访问」模式时，你需要的不是又一个权限档位，而是一层**确定性的事前防护**：AI 意外执行 `rm -rf C:/Users`、把文件写到桌面/home 这类灾难，先弹个确认框再放行。同一条命令永远得到同一判定——纯规则匹配，无 AI 判断、无网络请求、无第三方依赖。

## 它防什么：Windows 上真实会发生的意外

盘符路径、Git Bash 路径风格、Windows 环境变量、真实临时目录——这些在 macOS 思维的工具里最容易漏的东西，这里是地基能力：

| 场景 | zcode-fence 行为 |
| --- | --- |
| `rm -rf C:/Users` / `echo x > C:/Users/x/pwn.txt`（盘符路径，正反斜杠均可） | ask |
| `echo x > "C:/Users/…/f"`（带引号的重定向目标） | 剥引号后判定 → ask |
| Git Bash / MSYS 路径 `/c/Users/...`、`echo x > /tmp/f` | 归一化为 `C:\Users\...`；`/tmp` 映射到 `%TEMP%`（写临时目录放行） |
| `%USERPROFILE%` / `$HOME` / `%TEMP%` 等变量路径 | 展开后再判定 |
| `del /s /q C:\Users\x`、`format D:`、`Remove-Item -Recurse C:\`、`reg delete` 根键、`cipher /w:` 等 Windows 灾难命令 | 内置规则 → ask |
| 复合命令 `a && b & c\nd`（含单个 `&`、换行） | 完整切分逐段判定，后续段不逃逸 |
| `rm -rf node_modules`、`git reset --hard`、任意项目内读写 | 放行（零误报哲学） |
| 运行时 | 纯 Node（ZCode 是 Electron 应用，node 必在）、零依赖、Windows 默认环境即可用 |

## 它做什么 / 不做什么

两层防护，独立开关：

1. **危险命令门**（`enable_danger_gate`）：token 级精确组合匹配，只收**灾难级**——`rm -rf /`、`rm -rf ~`、`del /s /q C:\Users\x`、`format D:`、`dd of=/dev/sda`、`mkfs`、`diskutil eraseDisk`、fork 炸弹、`--no-preserve-root`、`chmod -R` 作用于根/home、PowerShell `Remove-Item` 作用于盘根/home、`reg delete` 根键、`cipher /w:`、`vssadmin delete shadows` 等；支持自定义正则。
2. **项目围栏**（`enable_fence`）：文件写入限制在**可写根**内 = 项目根（宿主注入的 `ZCODE_PROJECT_DIR`）+ 当前平台**真实临时目录**（Windows 读 `TEMP`/`TMP`，Unix 用 `TMPDIR` 且 `/tmp` 保留）+ ZCode 项目记忆目录（`~/.zcode/cli/memories`，宿主记忆功能高频写入，默认放行）+ 用户配置的额外可写根。Bash 命令按启发式判定（重定向目标、cp/mv/tar/curl/tee 等写命令的目标位），文件工具（Write/Edit/ApplyPatch）做精确判定（realpath + 符号链接逐级上溯防偷渡）。

**零误报哲学**：项目内行为由你自己的提示词约束，插件只管「灾难」和「越界」两件事。

**非目标（诚实声明）**：这不是 OS 级沙箱。本质是「执行前看命令文本」，以下手段天然绕过（防误操作，不防恶意绕过）：

- 脚本内部写入（`python -c "open('/etc/x','w')"`）、编码载荷（`powershell -EncodedCommand`）、脚本文件内容（`powershell -File x.ps1`）；
- 相对路径 + `cd` 出项目再写（`cd /c/Users/x && touch y` 放行，文档化盲区）；
- 网络访问（ZCode 插件 API 控制不了）。

## ask-only：只加锁，不开锁（本项目最重要的设计决定）

hook 的 `allow` 唯一效果是跳过宿主例行询问——**只会让模式更宽松，不会更安全**。因此本插件**永不输出 `allow`**（也不用 `deny`）：命中违规输出 `ask`，其余一律无输出、exit 0，交还宿主按其自身模式处理。`ask` 优先于宿主权限模式，完全访问下也强制弹确认；确认框就是升权通道，用户批一次放一次。

| 宿主模式 | 界内正常操作 | 危险命令/越界写 | 净效果 |
| --- | --- | --- | --- |
| 完全访问（主战场） | 沉默 = 照常执行 | 弹确认 | 围栏完整 |
| 自动编辑 | 沉默 = 宿主原样 | 弹确认（Bash 本来就问） | 语义零改变，白赚越界文件写保护 |
| 变更前确认 | 沉默 = 宿主照旧每步问 | 弹确认（与宿主询问重合） | 等价于没装插件 |
| 计划模式 | 不变 | 不变 | 不变 |

## 安装

**方式一：本地目录市场（开发/自用阶段）**

1. ZCode → 插件 → 添加市场 → 选择本仓库根目录（仓库根即本地插件市场 `marketplace.json`）；
2. 从该市场安装 `zcode-fence`。

**方式二：GitHub 市场（仓库推送到 GitHub 后）**

1. ZCode → 插件 → 添加市场 → 填入仓库地址 `https://github.com/Momenttttt/zcode-fence`；
2. 从该市场安装 `zcode-fence`。

两种方式装完后都要**新建任务**（hook 配置在任务启动时加载快照，安装/改配置后必须新建任务才生效），然后让 agent 跑一条 `echo x > C:/Users/<你>/Desktop/fence-test.txt`，弹确认即生效。

## 配置

配置在 ZCode 插件设置界面修改，持久化于 `~/.zcode/cli/config.json` 的 `plugins.options["zcode-fence@<市场名>"]`，**每次工具调用现读，改完（新建任务后）即生效**。注意设置界面是单行输入框会剥换行 → 所有清单类配置用分号 `;` 分隔，正则段内不能出现分号。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enable_danger_gate` | 布尔 | `true` | 危险命令门开关 |
| `enable_fence` | 布尔 | `true` | 项目围栏开关 |
| `custom_rules` | 字符串 | `""` | 自定义危险规则：分号分隔的 JS 正则（区分大小写），整条命令文本命中即 ask；编译失败自动跳过该段 |
| `extra_writable_roots` | 字符串 | `""` | 额外可写根：分号分隔，支持 `~`、`$VAR`、`%VAR%`。多文件夹项目把其余目录加进来（宿主不提供多文件夹清单，无法自动推断） |
| `enable_log` | 布尔 | `true` | 决策日志开关 |

## CLI 自测与决策日志

不依赖 ZCode，直接打印判定结果。stdout 与 hook 输出完全一致（ask 时打印决策 JSON，放行时为空，方便脚本消费）；另在 stderr 打一行人读摘要（如 `decision=silent（无输出，交还宿主）`），排障时肉眼即可确认判定：

```bash
export ZCODE_PROJECT_DIR="$PWD"
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf C:/Users'        # → ask（危险命令）
node plugins/zcode-fence/scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask（越界写入）
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node plugins/zcode-fence/scripts/guard.js --eval-write 'C:\Users\x\Desktop\a.txt'  # → ask
node plugins/zcode-fence/scripts/guard.js --help
```

决策日志（默认开）写入插件数据目录 `~/.zcode/cli/plugins/data/zcode-fence@<市场名>/decisions.log`（JSONL，5MB 自动轮转），每次 ask/silent/异常一行，便于事后审计「刚才为什么没拦」。stdin 解析失败或内部异常时 fail-open（exit 0 无输出），异常同样留痕。

agent 收到 `[zcode-fence: ...]` 拦截标记后的正确响应方式见 [SKILL.md](plugins/zcode-fence/skills/zcode-fence/SKILL.md)：换项目内/临时目录路径，或请求用户批准；不要原样重试、不要尝试绕过。

## 安全声明

- 无网络行为、不收集任何数据；全部判定在本地完成，可审计（决策日志）。
- 规则全部内置可读（`plugins/zcode-fence/scripts/guard.js`），无远程规则下发。

## 开发与测试

```bash
npm test   # node tests/unit.js && node tests/run.js
```

- `tests/unit.js`：normalizePath / 切分 / token 提取 / 灾难目标 / 配置读取等纯函数单测；
- `tests/run.js`：验收用例（`tests/cases.json`）全部走 `guard.js` 真实入口（`--eval` / stdin），
  内置全局不变量：**任何用例不得出现 allow/deny 输出**（ask-only 是项目级设计决定，防止未来破戒）、
  ask 输出必须精确符合宿主 schema、marketplace.json 与 plugin.json 版本必须一致；
- CI：GitHub Actions 三平台矩阵（windows/ubuntu/macos + node16 兼容作业）。

发版提醒：`marketplace.json` 与 `plugins/zcode-fence/.zcode-plugin/plugin.json` 的 `version` 必须同步修改（有测试把关）。

## License

[MIT](LICENSE) © 2026 zcode-fence contributors

灵感来自 [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard)（MIT）。
