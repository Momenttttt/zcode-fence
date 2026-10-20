<p align="center"><img src="assets/icon.png" width="120" alt="zcode-fence 图标"></p>

<p align="center"><strong>简体中文</strong> ｜ <a href="README_EN.md">English</a></p>

# zcode-fence

**ZCode 确定性围栏插件：危险命令门 + 项目围栏。Windows 优先适配，三平台可用；ask-only，零依赖（Node ≥ 16）。**

日常开着「完全访问」模式时，你需要的不是又一个权限档位，而是一层**确定性的事前防护**：AI 意外执行 `rm -rf C:/Users`、把文件写到桌面/home 这类灾难，先弹个确认框再放行。同一条命令永远得到同一判定。判定靠纯规则匹配，不经过 AI 判断，默认不联网，也不依赖任何第三方库；需要覆盖规则无法静态判断的语义风险时，可显式开启可选的决策模型审核层。

## 它防什么：Windows 上真实会发生的意外

盘符路径、Git Bash 路径风格、Windows 环境变量、真实临时目录，这些细节常被按 macOS/Unix 习惯设计的工具遗漏，在本项目里是基础能力：

| 场景 | zcode-fence 行为 |
| --- | --- |
| `rm -rf C:/Users` / `echo x > C:/Users/x/pwn.txt`（盘符路径，正反斜杠均可） | ask |
| `echo x > "C:/Users/…/f"`（带引号的重定向目标） | 剥引号后判定 → ask |
| Git Bash / MSYS 路径 `/c/Users/...`、`echo x > /tmp/f` | 归一化为 `C:\Users\...`；`/tmp` 映射到 `%TEMP%`（写临时目录放行） |
| `%USERPROFILE%` / `$HOME` / `%TEMP%` 等变量路径 | 展开后再判定 |
| `del /s /q C:\Users\x`、`format D:`、`Remove-Item -Recurse C:\`、`reg delete` 根键、`cipher /w:` 等 Windows 灾难命令 | 内置规则 → ask |
| 复合命令 `a && b & c\nd`（含单个 `&`、换行） | 完整切分逐段判定，后续段不逃逸 |
| 包装器藏命令：`env -i rm -rf /`、`sudo -u root rm -rf /`、`nice -n 10 …`、`timeout 10 …`、`stdbuf -o0 …`、`bash -lc '…'` | 剥掉选项链/组合短开关后继续判定 → ask |
| `find / -delete`、`find / -exec rm -rf {} +`、`xargs rm -rf`、`sed -i … /etc/passwd`、`awk 'BEGIN{system(…)}'`、解释器 shell 载荷 | ask |
| `curl … \| bash`、`bash <(curl …)`、`eval "$(curl …)"` | ask（远程代码执行） |
| Git 不可逆：`git push --force`、`git reset --hard`、`git clean -fdx`、`git branch -D` | ask（项目内也问） |
| 系统持久化：`crontab -r`、`systemctl enable`、`reg add`、`schtasks /create`、防火墙关闭 | ask |
| `rm -rf node_modules`、`mv src/a.ts src/b.ts`、项目内 `chmod +x`、`git status` | 放行（零误报哲学） |
| 运行时 | 纯 Node 实现（ZCode 本身是 Electron 应用，node 环境天然可用）、零依赖，Windows 默认环境开箱即用 |

## 它做什么 / 不做什么

两层确定性防护，独立开关；另有一层默认关闭的可选决策模型审核：

1. **危险命令门**（`enable_danger_gate`）：token 级精确组合匹配，只收**灾难级**：`rm -rf /`、`rm -rf ~`、`del /s /q C:\Users\x`、`format D:`、`dd of=/dev/sda`、`mkfs`、`diskutil eraseDisk`、fork 炸弹、`--no-preserve-root`、`chmod -R` 作用于根/home、PowerShell `Remove-Item` 作用于盘根/home、`reg delete` 根键、`cipher /w:`、`vssadmin delete shadows`、`shutdown`/`reboot` 等关机重启命令、`systemctl poweroff`、`bcdedit` 写引导、`diskpart` 等；藏进 `trap`/`eval`/`$()`/反引号载荷、混在 `then`/`do` 等控制流关键字后面的危险命令照样能识破；`node -e`/`python -c` 这类解释器内嵌脚本，只要写 API 和绝对路径字面量同时出现就拦（如 `node -e "…rmSync('C:/Windows'…)"`）。v1.4.0 进一步覆盖：包装器选项链与组合短开关、`find -delete`/`-exec` 按查找根判定、`xargs` 动态删除目标、`sed -i` 文件操作数、`awk system()` 与 `php -r`/`deno eval`/`bun -e`/`osascript` 的 shell 执行载荷、`curl | bash`/`bash <(curl)`/`eval "$(curl)"` 远程执行、`mount`/`umount`/`fdisk`/`parted` 变更、Git 不可逆操作（force/delete/mirror push、`branch -D`、`reset --hard`、`clean -fdx`、丢弃改动的 checkout/restore、`stash clear/drop` 等）、系统持久化（crontab、iptables flush、防火墙关闭、`reg add/delete`、`sc delete`、`systemctl enable/disable/mask/unmask`、`launchctl load/unload/bootstrap/bootout`、`schtasks /create|/delete|/change`）；支持自定义正则。
2. **项目围栏**（`enable_fence`）：文件写入限制在**可写根**内 = 项目根（宿主注入的 `ZCODE_PROJECT_DIR`）+ 当前平台**真实临时目录**（Windows 读 `TEMP`/`TMP`，Unix 用 `TMPDIR` 且 `/tmp` 保留）+ ZCode 项目记忆目录（`~/.zcode/cli/memories`，宿主记忆功能高频写入，默认放行）+ 用户配置的额外可写根。Bash 命令按启发式判定（重定向目标、cp/mv/tar/curl/tee 等写命令的目标参数、`chmod`/`chown` 的全部路径操作数、`mv` 的源与目标、`sed -i` 的文件操作数、`find` 的删除根、解释器内嵌脚本里与写 API 同时出现的路径字面量）；命令内 `cd`/`pushd`/`popd` 会更新后续段的当前目录，相对写目标先按该目录解析再与可写根比较；文件工具（Write/Edit/ApplyPatch）做精确判定（realpath + 符号链接逐级上溯防偷渡）。

**会话根锁定**（`lock_session_root`）：实测宿主注入的项目根跟着 Bash 当前目录走，agent `cd` 进子目录后，后续所有调用（含 Write/Edit）的项目根一起漂移，`cd` 出项目更会让围栏整段失效。开启后按每个会话**首次见到的根**判定，这个根基本就是会话打开时的工作区：cd 进子目录不会把写项目根误判成越界，cd 出项目之后越界写照样拦。状态记在插件数据目录的一个 `session-roots.log` 里（每会话一行、30 天过期、上限 200 条）。

**可选决策模型审核层**（`enable_decision_model`，默认关闭）：只在确定性两层都沉默时，把工具名、命令或文件路径、项目根发给配置的决策模型，单问「是否该让用户确认」并附带效果类别（只读、项目内写、Git 历史、数据删除、系统变更、外部副作用、数据外带）。模型只能产生 ask 或沉默；概率达到阈值（默认 0.6）才弹确认。超时（默认 3500ms，上限 4000ms）、网络错误、返回不合法或未配置端点一律 fail-open，确定性层结论不受影响，状态写入决策日志。请求前会脱敏 API key/token/password/Authorization/私钥块和长密钥，只发送工具名、命令/路径和项目根，不发送文件内容、对话历史或会话记忆。端点、模型、API key、阈值、超时、headers、代理和 prompt 全部可配；源码不硬编码任何厂商端点。

**零误报哲学**：项目内日常操作（`rm -rf node_modules`、`mv src/a.ts src/b.ts`、`chmod +x src/script.sh` 等）一律放行；插件只管「灾难」「越界」和「不可逆损失」三件事。Git 是例外：会丢失未提交改动、未跟踪文件、远程分支/标签或历史的操作，即使发生在项目内也会 ask。

**防不了什么（诚实声明）**：这不是 OS 级沙箱，本质是「执行前看一眼命令文本」，以下手段都能绕过它（防误操作，不防恶意绕过）：

- 编码载荷（`powershell -EncodedCommand`）、脚本文件内容（`powershell -File x.ps1`、`node x.js`）、载荷内无路径字面量的写入（拼接 `process.env.HOME + '/x'`、用变量拼出命令再交给 `child_process` 等间接执行）；
- 敏感文件读取/外带（SSH 私钥、`.env`、云凭证）；相对越界写已由命令内 cwd 跟踪覆盖（`cd /c/Users/x && touch y` 会 ask），但 `cd` 进入临时目录等可写根后仍按白名单放行；
- 网络访问（ZCode 插件 API 控制不了）。

## ask-only：只加锁，不开锁（本项目最重要的设计决定）

hook 的 `allow` 唯一效果是跳过宿主例行询问，**只会让模式更宽松，不会更安全**。因此本插件**永不输出 `allow`**（也不用 `deny`）：命中违规输出 `ask`，其余一律无输出、exit 0，交还宿主按其自身模式处理。`ask` 优先于宿主权限模式，完全访问下也强制弹确认；确认框就是升权通道，用户批一次放一次。

| 宿主模式 | 界内正常操作 | 危险命令/越界写 | 实际效果 |
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

配置在 ZCode 插件设置界面修改，保存到 `~/.zcode/cli/config.json` 的 `plugins.options["zcode-fence@<市场名>"]` 下（未改动过的项不会写入文件，插件按默认值运行）。**配置值每次工具调用时都会重新读取，改完立即生效；只有安装/启停插件本身需要新建任务。** 注意：设置界面是单行输入框，换行会被剥掉，所以清单类配置一律用分号 `;` 分隔，正则里也不能出现分号。

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enable_danger_gate` | 布尔 | `true` | 危险命令门开关 |
| `enable_fence` | 布尔 | `true` | 项目围栏开关 |
| `lock_session_root` | 布尔 | `true` | 会话根锁定：按会话首见根判定，忽略 cd 漂移，cd 进子目录不误报、cd 出项目不失效。状态存于插件数据目录 session-roots.log |
| `custom_rules` | 字符串 | `""` | 自定义危险规则：分号分隔的 JS 正则（区分大小写），整条命令文本命中即 ask；编译失败自动跳过该段 |
| `extra_writable_roots` | 字符串 | `""` | 额外可写根：分号分隔，支持 `~`、`$VAR`、`%VAR%`。多文件夹项目把其余目录加进来（宿主不提供多文件夹清单，无法自动推断） |
| `enable_log` | 布尔 | `true` | 决策日志开关 |
| `enable_decision_model` | 布尔 | `false` | 决策模型审核层总开关（默认关闭；关闭时不发起任何网络请求） |
| `decision_model_endpoint` | 字符串 | `""` | 决策模型完整 POST 地址；必须 https，本机/私网可用 http |
| `decision_model_model` | 字符串 | `""` | 请求体 model 字段；留空不发送 |
| `decision_model_api_key` | 字符串 | `""` | Bearer key；环境变量 `ZCODE_FENCE_DECISION_MODEL_API_KEY` 优先 |
| `decision_model_threshold` | 字符串 | `"0.6"` | 确认概率阈值 0–1 |
| `decision_model_timeout_ms` | 字符串 | `"3500"` | 超时毫秒，上限 4000（hook 总超时 5000） |
| `decision_model_headers` | 字符串 | `""` | 额外请求头，分号分隔 `Name: Value` |
| `decision_model_proxy` | 字符串 | `""` | `http://` 代理；留空读环境代理，NO_PROXY 与本机直连 |
| `decision_model_prompt` | 字符串 | `""` | 可选，覆盖「是否该让用户确认」的提示词 |

## CLI 自测与决策日志

不依赖 ZCode，直接打印判定结果。stdout 与 hook 输出完全一致（ask 时打印决策 JSON，放行时为空，方便脚本解析）；stderr 则输出一行简明摘要（如 `decision=silent（无输出，交还宿主）`），排障时一眼即可确认判定：

```bash
export ZCODE_PROJECT_DIR="$PWD"
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf C:/Users'        # → ask（危险命令）
node plugins/zcode-fence/scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask（越界写入）
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node plugins/zcode-fence/scripts/guard.js --eval-write 'C:\Users\x\Desktop\a.txt'  # → ask
node plugins/zcode-fence/scripts/guard.js --help
```

决策日志（默认开）写入插件数据目录 `~/.zcode/cli/plugins/data/zcode-fence@<市场名>/decisions.log`（JSONL，5MB 自动轮转），每次判定（ask/放行/异常）都记一行，便于事后审计「刚才为什么没拦」。stdin 解析失败或内部异常时 fail-open（exit 0 无输出），异常同样留痕。

agent 收到 `[zcode-fence: ...]` 拦截标记后该怎么做，见 [SKILL.md](plugins/zcode-fence/skills/zcode-fence/SKILL.md)：改用项目内/临时目录路径，或请求用户批准；不要原样重试、不要尝试绕过。

## 安全声明

- 默认无网络行为、不收集任何数据；全部确定性判定在本地完成，可审计（决策日志）。
- 只有显式开启 `enable_decision_model` 后，才会向配置端点发送脱敏后的工具调用信息（工具名、命令/路径、项目根）；不发送文件内容、对话历史或会话记忆。
- 规则全部内置可读（`plugins/zcode-fence/scripts/guard.js`），无远程规则下发。

## 开发与测试

```bash
npm test   # node tests/unit.js && node tests/run.js && node tests/decision-model.js
```

- `tests/unit.js`：normalizePath / 切分 / token 提取 / 灾难目标 / 配置读取等纯函数单测；
- `tests/decision-model.js`：本地 mock HTTP 服务覆盖决策模型的 ask/silent/阈值/超时/HTTP 错误/非法 JSON/未配置端点/脱敏，不访问外网；
- `tests/run.js`：验收用例（`tests/cases.json`）全部走 `guard.js` 真实入口（`--eval` / stdin），
  内置全局不变量：**任何用例不得出现 allow/deny 输出**（ask-only 是项目级设计决定，防止未来破戒）、
  ask 输出必须精确符合宿主 schema、marketplace.json 与 plugin.json 版本必须一致、
  DEFAULT_CONFIG 与清单 userConfig 键必须一致、参考项目名不得出现在源码/测试/配置中；
- CI：GitHub Actions 三平台矩阵（windows/ubuntu/macos + node16 兼容作业）。

发版提醒：`marketplace.json` 与 `plugins/zcode-fence/.zcode-plugin/plugin.json`、`plugins/zcode-fence/.claude-plugin/plugin.json`（Claude 兼容拷贝）三处的 `version` 必须同步修改（有测试把关）。

## License

[MIT](LICENSE) © 2026 zcode-fence contributors

设计思路参考了 [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard)（MIT）、[leepokai/jev-guard](https://github.com/leepokai/jev-guard)、[kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) 与 [openchamber/openchamber](https://github.com/openchamber/openchamber)；仅吸收思路，未复制代码。
