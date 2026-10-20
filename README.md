<p align="center"><img src="assets/icon.png" width="120" alt="zcode-fence 图标"></p>

<p align="center"><strong>简体中文</strong> ｜ <a href="README_EN.md">English</a></p>

# zcode-fence

**给 AI 划三条硬线：灾难命令、越界写入、不可逆损失。它只弹确认，不替你做决定。**

纯规则匹配，零依赖（Node ≥ 16），默认不联网；关闭可选的决策模型时，同一条命令永远得到同一判定。Windows 优先适配，macOS / Linux 同样可用。

## 30 秒看懂

- **挂在哪**：ZCode 的 PreToolUse hook，每条 Bash / Write / Edit / ApplyPatch 执行前检查一次。
- **拦什么**：灾难级命令、写出可写根、不可逆操作（含项目内的 Git 破坏性操作）。
- **怎么拦**：只输出 `ask` 弹确认；从不 `allow`、从不 `deny`。批准一次，放行一次。
- **放什么**：项目内日常操作——`rm -rf node_modules`、`mv`、`chmod`、`git status`——一律沉默放行。
- **不做什么**：不是沙箱，不防恶意绕过；不开启决策模型时，不发起任何网络请求。

## 它防什么

| 类别 | 典型命令（命中即 ask） |
| --- | --- |
| 灾难级删除 | `rm -rf /`、`rm -rf ~`、`del /s /q C:\Users` |
| 磁盘与系统破坏 | `format D:`、`dd of=/dev/sda`、`mkfs`、`diskpart`、`Remove-Item C:\`、`reg delete` 根键、`vssadmin delete shadows` |
| 关机与引导 | `shutdown`、`reboot`、`systemctl poweroff`、`bcdedit` 写引导 |
| 越界写入 | `echo x > C:/Users/…/f`、`cp` / `mv` / `tar` / `curl -o` 指向项目外、Write/Edit 写桌面、home 或系统目录 |
| 不可逆 Git | `push --force`、`reset --hard`、`clean -fdx`、`branch -D`、`stash drop/clear`、丢弃改动的 `checkout` / `restore` |
| 远程代码执行 | `curl … \| bash`、`bash <(curl …)`、`eval "$(curl …)"` |
| 系统持久化 | `crontab -r`、`systemctl enable`、`reg add`、`schtasks /create`、`launchctl load/unload`、关闭防火墙 |
| 藏起来的命令 | `env` / `sudo` / `nice` / `timeout` 等包装器、`bash -lc`、`find -delete` / `-exec`、`xargs rm`、`sed -i`、`node -e` / `python -c` / `php -r` / `awk system()` / `osascript` 内嵌脚本 |

反过来，这些不会误报：项目内 `rm -rf node_modules`、`mv src/a.ts src/b.ts`、`chmod +x`、`git status`，以及写项目根、临时目录、ZCode 记忆目录。

> 这不是完整清单。全部规则以可读的表结构写在 [`guard.js`](plugins/zcode-fence/scripts/guard.js) 里，并配有验收用例；README 只列最容易出事的形状。

## Windows 不是补丁，是地基

盘符路径（正反斜杠均可）、Git Bash / MSYS 路径（`/c/Users/...`）、Windows 环境变量（`%USERPROFILE%`、`%TEMP%`、`$HOME`）、带引号的重定向目标、真实临时目录——这些按 Unix 习惯写工具时最容易漏掉的细节，在这里都先归一化再判定。`/tmp` 在 Windows 上映射到真实 `%TEMP%`，写临时目录不会误报。

## 工作方式：两层确定性防护 + 一个可选层

| 层 | 开关 | 看什么 | 命中后 |
| --- | --- | --- | --- |
| 危险命令门 | `enable_danger_gate` | 命令是不是灾难级、不可逆或系统级变更 | ask |
| 项目围栏 | `enable_fence` | 写入目标在不在可写根内 | ask |
| 决策模型（可选） | `enable_decision_model`，默认关 | 前两层沉默时的语义风险 | ask 或沉默 |

两层互相独立，各自开关、各自履职：关掉危险门，`rm -rf /` 仍会被围栏当作越界写兜底。

### 危险命令门

只管灾难级、不可逆和系统级变更，不碰项目内日常删除。判定前先剥壳：

- **包装器**：`env`、`sudo`、`nice`、`timeout`、`stdbuf`、`nohup`、`time`、`command`、`exec`、`strace`、`wsl`，跳过选项链与组合短开关（如 `bash -lc`）后再判定；
- **shell 与控制流**：`bash -c`、`powershell -Command`、`trap`、`eval`、`$()`、反引号、`then` / `do` 后面的命令；
- **解释器内嵌脚本**：`node -e`、`python -c`、`php -r`、`deno eval`、`bun -e`、`awk system()`、`osascript`，写 API 与绝对路径字面量同时出现即拦。

规则之外可以用 `custom_rules` 追加以分号分隔的 JS 正则。

### 项目围栏

文件写入限制在四个可写根内：

1. 项目根（宿主注入的 `ZCODE_PROJECT_DIR`）；
2. 当前平台的真实临时目录（Windows 读 `TEMP` / `TMP`，Unix 用 `TMPDIR` 且保留 `/tmp`）；
3. ZCode 项目记忆目录（`~/.zcode/cli/memories`）；
4. `extra_writable_roots` 里配置的额外目录。

Bash 命令按写目标启发式判定：重定向目标、`cp` / `mv` / `tar` / `curl -o` / `tee` 等写命令的目标、`chmod` / `chown` 的全部路径操作数、`mv` 的源与目标、`sed -i` 的文件、`find` 的删除根。命令内 `cd` / `pushd` / `popd` 会更新后续段的当前目录，相对路径按它解析后再比较。Write / Edit / ApplyPatch 做精确判定：realpath 加逐级上溯，防符号链接偷渡。

### 会话根锁定（`lock_session_root`）

宿主注入的项目根会跟着 Bash 的当前目录走：agent `cd` 进子目录，后续所有调用（含 Write/Edit）的根一起漂移；`cd` 出项目，围栏整段失效。开启后按每个会话**首次见到的根**判定，也就是会话打开时的工作区。状态记在插件数据目录的 `session-roots.log`（每会话一行，30 天过期，上限 200 条）。

### 可选决策模型审核层（默认关闭）

规则只能看形状，看不懂语义。开启后，只有前两层都沉默时才会把工具名、命令或路径、项目根发给配置的模型，问一个问题：这次操作是否该让用户确认？模型只能回 ask 或沉默，概率达到阈值（默认 0.6）才弹确认。

未配置端点、超时（默认 3500ms，上限 4000ms）、网络错误、响应不合法，一律 fail-open，确定性层的结论不受影响。发送前脱敏 API key / token / password / Authorization / 私钥块，不发送文件内容、对话历史或会话记忆；端点、模型、key、阈值、超时、headers、代理、prompt 全部可配，源码不硬编码厂商地址。

## ask-only：只加锁，不开锁

hook 的 `allow` 唯一效果是跳过宿主例行询问，只会让模式更宽松，不会更安全。所以本插件**永不输出 `allow`**，也不用 `deny`：命中违规输出 `ask`，其余无输出、exit 0，交还宿主按自己的权限模式处理。`ask` 优先于宿主模式，完全访问下也强制弹确认；确认框就是升权通道。

| 宿主模式 | 界内正常操作 | 危险命令 / 越界写 | 实际效果 |
| --- | --- | --- | --- |
| 完全访问（主战场） | 沉默，照常执行 | 弹确认 | 围栏完整 |
| 自动编辑 | 沉默，宿主原样 | 弹确认（Bash 本来就问） | 语义零改变，白赚越界文件保护 |
| 变更前确认 | 沉默，宿主照旧每步问 | 弹确认（与宿主重合） | 等价于没装 |
| 计划模式 | 不变 | 不变 | 不变 |

## 安装

**方式一：GitHub 市场**

1. ZCode → 插件 → 添加市场 → 填入 `https://github.com/Momenttttt/zcode-fence`；
2. 安装 `zcode-fence`。

**方式二：本地目录市场（开发或自用）**

1. ZCode → 插件 → 添加市场 → 选择本仓库根目录（根目录的 `marketplace.json` 就是本地市场）；
2. 安装 `zcode-fence`。

装完必须**新建任务**：hook 配置在任务启动时快照，安装和启停只在新建任务后生效。随后让 agent 执行：

```bash
echo x > C:/Users/<你>/Desktop/fence-test.txt
```

弹出确认即说明围栏已生效。

## 配置

在插件设置界面修改，写入 `~/.zcode/cli/config.json` 的 `plugins.options["zcode-fence@<市场名>"]`。**每次工具调用都会重新读取，改完立即生效**；只有安装/启停需要新建任务。设置界面是单行输入框，换行会被剥掉，所以清单类配置用分号 `;` 分隔，正则里不能出现分号。

**基础**

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enable_danger_gate` | 布尔 | `true` | 危险命令门开关 |
| `enable_fence` | 布尔 | `true` | 项目围栏开关 |
| `lock_session_root` | 布尔 | `true` | 会话根锁定：按会话首见根判定，忽略 cd 漂移 |
| `custom_rules` | 字符串 | `""` | 自定义危险规则：分号分隔的 JS 正则（区分大小写），整条命令命中即 ask；编译失败自动跳过 |
| `extra_writable_roots` | 字符串 | `""` | 额外可写根：分号分隔，支持 `~`、`$VAR`、`%VAR%`。多文件夹项目把其余目录加进来 |
| `enable_log` | 布尔 | `true` | 决策日志开关 |

**决策模型**

| 键 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enable_decision_model` | 布尔 | `false` | 审核层总开关；关闭时不发任何网络请求 |
| `decision_model_endpoint` | 字符串 | `""` | 完整 POST 地址；必须 https，本机/私网可用 http |
| `decision_model_model` | 字符串 | `""` | 请求体 `model` 字段；留空不发送 |
| `decision_model_api_key` | 字符串 | `""` | Bearer key；环境变量 `ZCODE_FENCE_DECISION_MODEL_API_KEY` 优先 |
| `decision_model_threshold` | 字符串 | `"0.6"` | 确认概率阈值 0–1 |
| `decision_model_timeout_ms` | 字符串 | `"3500"` | 超时毫秒，上限 4000（hook 总超时 5000） |
| `decision_model_headers` | 字符串 | `""` | 额外请求头，分号分隔 `Name: Value` |
| `decision_model_proxy` | 字符串 | `""` | `http://` 代理；留空读环境代理，NO_PROXY 与本机直连 |
| `decision_model_prompt` | 字符串 | `""` | 可选，覆盖「是否该让用户确认」的提示词 |

## 自测与日志

不启动 ZCode 也能直接看判定结果。stdout 与 hook 输出完全一致（ask 时是决策 JSON，放行时为空），stderr 给人读的摘要：

```bash
export ZCODE_PROJECT_DIR="$PWD"
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf C:/Users'         # → ask（危险命令）
node plugins/zcode-fence/scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask（越界写入）
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node plugins/zcode-fence/scripts/guard.js --eval-write 'C:\Users\x\Desktop\a.txt'  # → ask
node plugins/zcode-fence/scripts/guard.js --help
```

决策日志默认开启，写在 `~/.zcode/cli/plugins/data/zcode-fence@<市场名>/decisions.log`（JSONL，5MB 自动轮转），每次 ask/放行/异常一行，方便事后回答「刚才为什么没拦」。stdin 非法或内部异常时 fail-open（exit 0 无输出），异常同样留痕。

agent 收到 `[zcode-fence: ...]` 标记后该怎么做，见 [SKILL.md](plugins/zcode-fence/skills/zcode-fence/SKILL.md)：改用项目内或临时目录路径，或请求用户批准；不要原样重试，不要尝试绕过。

## 局限（诚实声明）

这不是 OS 级沙箱，本质是执行前看一眼命令文本，防误操作，不防恶意绕过：

- 编码载荷（`powershell -EncodedCommand`）、脚本文件内容（`powershell -File`、`node x.js`）；
- 载荷里没有路径字面量的写入（变量拼接、把命令拼好再交给 `child_process`）；
- 敏感文件读取与外带（SSH 私钥、`.env`、云凭证）；
- 网络访问（ZCode 插件 API 控制不了）。

相对越界写不在此列：命令内 cwd 跟踪能判定 `cd /c/Users/x && touch y`；`cd` 进临时目录、记忆目录或项目目录后的相对写，仍按可写根白名单放行。

## 开发与测试

```bash
npm test   # node tests/unit.js && node tests/run.js && node tests/decision-model.js
```

- `tests/unit.js`：路径归一化、命令切分、token 提取、灾难目标、配置读取等纯函数单测；
- `tests/run.js`：验收用例全部走真实入口（`--eval` / stdin），并扫描全局不变量——任何用例不得输出 allow/deny、ask 必须精确匹配宿主 schema、三处版本号一致、DEFAULT_CONFIG 与清单 userConfig 键一致；
- `tests/decision-model.js`：本地 mock HTTP 服务覆盖决策模型的 ask/silent/阈值/超时/HTTP 错误/非法 JSON/未配置端点/脱敏，不访问外网。

CI 跑 Windows / Ubuntu / macOS 三平台矩阵，另有 Node 16 兼容作业。发版时同步修改 `marketplace.json`、`.zcode-plugin/plugin.json` 和 `.claude-plugin/plugin.json` 三处 `version`（有测试把关）。

## License

[MIT](LICENSE) © 2026 zcode-fence contributors

灵感来自 [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard)（MIT）；设计思路另参考了 [leepokai/jev-guard](https://github.com/leepokai/jev-guard)、[kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) 与 [openchamber/openchamber](https://github.com/openchamber/openchamber)，仅吸收思路，未复制代码。
