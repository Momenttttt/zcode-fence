# zcode-fence

**ZCode 确定性围栏插件：危险命令门 + 项目围栏。Windows 优先适配，三平台可用；ask-only，零依赖（Node ≥ 16）。**

日常开着「完全访问」模式时，你需要的不是又一个权限档位，而是一层**确定性的事前防护**：AI 意外执行 `rm -rf C:/Users`、把文件写到桌面/home 这类灾难，先弹个确认框再放行。同一条命令永远得到同一判定——纯规则匹配，无 AI 判断、无网络请求、无第三方依赖。

## 它做什么

两层防护，独立开关：

1. **危险命令门**（`enable_danger_gate`）：token 级精确组合匹配，只收**灾难级**——`rm -rf /`、`rm -rf ~`、`del /s /q C:\Users\x`、`format D:`、`dd of=/dev/sda`、`mkfs`、`diskutil eraseDisk`、fork 炸弹、`--no-preserve-root`、`chmod -R` 作用于根/home、PowerShell `Remove-Item` 作用于盘根/home、`reg delete` 根键、`cipher /w:`、`vssadmin delete shadows` 等；支持自定义正则。
2. **项目围栏**（`enable_fence`）：文件写入限制在**可写根**内 = 项目根（宿主注入的 `ZCODE_PROJECT_DIR`）+ 当前平台**真实临时目录**（Windows 读 `TEMP`/`TMP`，Unix 用 `TMPDIR` 且 `/tmp` 保留）+ ZCode 项目记忆目录（`~/.zcode/cli/memories`）+ 用户配置的额外可写根。Bash 命令按启发式判定（重定向目标、cp/mv/tar/curl/tee 等写命令的目标参数），文件工具（Write/Edit/ApplyPatch）做精确判定（realpath + 符号链接逐级上溯防偷渡）。

盘符路径（正反斜杠均可）、Git Bash / MSYS 路径（`/c/Users/...`）、Windows 环境变量（`%USERPROFILE%`、`$HOME`）、真实临时目录——这些细节常被按 macOS/Unix 习惯设计的工具遗漏，在本项目里则是基础能力。

**零误报哲学**：项目内行为（`rm -rf node_modules`、`git reset --hard` 等）一律放行；插件只管「灾难」和「越界」两件事。

## ask-only：只加锁，不开锁

hook 的 `allow` 唯一效果是跳过宿主例行询问——**只会让模式更宽松，不会更安全**。因此本插件**永不输出 `allow`**（也不用 `deny`）：命中违规输出 `ask`，其余一律无输出、exit 0，交还宿主按其自身模式处理。`ask` 优先于宿主权限模式，完全访问下也强制弹确认；确认框就是升权通道，用户批一次放一次。

**防不了什么（诚实声明）**：这不是 OS 级沙箱，本质是「执行前看一眼命令文本」，防误操作、不防恶意绕过（脚本内部写入、编码载荷、相对路径 + `cd` 出项目再写、网络访问均不在能力范围内——文档化盲区）。

## 安装

1. ZCode → 插件 → 添加市场 → 填入仓库地址 `https://github.com/Momenttttt/zcode-fence`（或选择本地克隆的仓库根目录——仓库根即本地插件市场 `marketplace.json`）；
2. 从该市场安装 `zcode-fence`；
3. **新建任务**（hook 配置在任务启动时加载快照，安装后必须新建任务才生效），然后让 agent 跑一条 `echo x > C:/Users/<你>/Desktop/fence-test.txt`，弹确认即生效。

## 配置

配置在 ZCode 插件设置界面修改，保存到 `~/.zcode/cli/config.json` 的 `plugins.options["zcode-fence@<市场名>"]` 下。**配置值每次工具调用时都会重新读取，改完立即生效；只有安装/启停插件本身需要新建任务。** 注意：设置界面是单行输入框，换行会被剥掉，所以清单类配置一律用分号 `;` 分隔，正则里也不能出现分号。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enable_danger_gate` | 布尔 | `true` | 危险命令门开关 |
| `enable_fence` | 布尔 | `true` | 项目围栏开关 |
| `custom_rules` | 字符串 | `""` | 自定义危险规则：分号分隔的 JS 正则（区分大小写），整条命令文本命中即 ask；编译失败自动跳过该段 |
| `extra_writable_roots` | 字符串 | `""` | 额外可写根：分号分隔，支持 `~`、`$VAR`、`%VAR%`。多文件夹项目把其余目录加进来 |
| `enable_log` | 布尔 | `true` | 决策日志开关 |

## CLI 自测与决策日志

不依赖 ZCode，直接打印判定结果。stdout 与 hook 输出完全一致；stderr 输出一行简明摘要，排障时一眼即可确认判定：

```bash
export ZCODE_PROJECT_DIR="$PWD"
node scripts/guard.js --eval 'rm -rf C:/Users'         # → ask（危险命令）
node scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask（越界写入）
node scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node scripts/guard.js --help
```

决策日志（默认开）写入插件数据目录（基于 `ZCODE_PLUGIN_DATA`）的 `decisions.log`（JSONL，5MB 自动轮转），每次判定（ask/放行/异常）都记一行，便于事后审计「刚才为什么没拦」。stdin 解析失败或内部异常时 fail-open（exit 0 无输出），异常同样留痕。

agent 收到 `[zcode-fence: ...]` 拦截标记后该怎么做，见 [SKILL.md](skills/zcode-fence/SKILL.md)：改用项目内/临时目录路径，或请求用户批准；不要原样重试、不要尝试绕过。

## 数据与权限

- 无网络行为、不收集任何数据；全部判定在本地完成，可审计（决策日志）。
- hook 从 stdin 读取工具调用载荷，与内置可读规则（`scripts/guard.js`）做匹配；除插件数据目录的决策日志外不写任何文件。

## License

[MIT](https://github.com/Momenttttt/zcode-fence/blob/main/LICENSE) © 2026 zcode-fence contributors

灵感来自 [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard)（MIT）。

---

**简体中文** ｜ [English](README.md)
