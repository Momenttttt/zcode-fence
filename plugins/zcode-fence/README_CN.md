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

> 这不是完整清单。全部规则以可读的表结构写在 [`scripts/guard.js`](scripts/guard.js) 里，并配有验收用例。

## 工作方式

两层确定性防护，独立开关；另有一层默认关闭的可选审核：

| 层 | 开关 | 看什么 | 命中后 |
| --- | --- | --- | --- |
| 危险命令门 | `enable_danger_gate` | 命令是不是灾难级、不可逆或系统级变更 | ask |
| 项目围栏 | `enable_fence` | 写入目标在不在可写根内 | ask |
| 决策模型（可选） | `enable_decision_model`，默认关 | 前两层沉默时的语义风险 | ask 或沉默 |

**危险命令门**判定前先剥壳：包装器（`env`、`sudo`、`nice`、`timeout`、`stdbuf`、`nohup`、`time`、`command`、`exec`、`strace`、`wsl`）、shell 层（`bash -c`、`powershell -Command`、`trap`、`eval`、`$()`、反引号、`then` / `do` 后面的命令）、解释器内嵌脚本（`node -e`、`python -c`、`php -r`、`deno eval`、`bun -e`、`awk system()`、`osascript`）。规则之外可用 `custom_rules` 追加。

**项目围栏**把写入限制在四个可写根：项目根（宿主注入的 `ZCODE_PROJECT_DIR`）、当前平台真实临时目录（Windows 读 `TEMP` / `TMP`，Unix 用 `TMPDIR` 且保留 `/tmp`）、ZCode 记忆目录（`~/.zcode/cli/memories`）和 `extra_writable_roots`。Bash 命令按重定向目标、`cp` / `mv` / `tar` / `curl -o` / `tee` 的目标、`chmod` / `chown` 操作数、`sed -i` 文件、`find` 删除根判定；命令内 `cd` / `pushd` / `popd` 会更新后续段的当前目录。文件工具走 realpath 加逐级上溯，防符号链接偷渡。

**会话根锁定**（`lock_session_root`）按每个会话首次见到的根判定，`cd` 进子目录不误报，`cd` 出项目不失效。状态存于 `session-roots.log`（30 天过期，上限 200 条）。

**可选决策模型审核**默认关闭。只有前两层都沉默时，才把工具名、命令或路径、项目根发给配置的模型，问一个问题：这次操作是否该让用户确认？模型只能回 ask 或沉默，概率达到阈值（默认 0.6）才弹确认。未配置端点、超时、网络错误、响应不合法一律 fail-open 并写日志。发送前脱敏密钥，不发送文件内容、对话历史或会话记忆，源码不硬编码厂商地址。

**Windows 不是补丁，是地基**：盘符路径（正反斜杠均可）、Git Bash / MSYS 路径（`/c/Users/...`）、环境变量（`%USERPROFILE%`、`%TEMP%`、`$HOME`）、带引号的重定向目标、真实临时目录，全部先归一化再判定。

## ask-only：只加锁，不开锁

hook 的 `allow` 唯一效果是跳过宿主例行询问，只会让模式更宽松，不会更安全。所以本插件**永不输出 `allow`**，也不用 `deny`：命中违规输出 `ask`，其余无输出、exit 0，交还宿主按自己的权限模式处理。`ask` 优先于宿主模式，完全访问下也强制弹确认。

## 安装

1. ZCode → 插件 → 添加市场 → 填入 `https://github.com/Momenttttt/zcode-fence`（或选择本地克隆的仓库根目录，其 `marketplace.json` 就是市场）；
2. 安装 `zcode-fence`；
3. **新建任务**（hook 配置在任务启动时快照），然后让 agent 跑一条 `echo x > C:/Users/<你>/Desktop/fence-test.txt`，弹确认即生效。

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

```bash
export ZCODE_PROJECT_DIR="$PWD"
node scripts/guard.js --eval 'rm -rf C:/Users'         # → ask（危险命令）
node scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask（越界写入）
node scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node scripts/guard.js --help
```

stdout 与 hook 输出完全一致；stderr 输出一行给人读的摘要。决策日志默认开启，写在插件数据目录（基于 `ZCODE_PLUGIN_DATA`）的 `decisions.log`（JSONL，5MB 自动轮转），每次 ask/放行/异常一行。stdin 非法或内部异常时 fail-open（exit 0 无输出），异常同样留痕。

agent 收到 `[zcode-fence: ...]` 标记后该怎么做，见 [SKILL.md](skills/zcode-fence/SKILL.md)：改用项目内或临时目录路径，或请求用户批准；不要原样重试，不要尝试绕过。

## 数据与权限

- 默认无网络行为、不收集任何数据；确定性判定全部在本地完成，可审计。
- 只有显式开启 `enable_decision_model` 后，才会向配置端点发送脱敏后的工具调用信息（工具名、命令/路径、项目根）；不发送文件内容、对话历史或会话记忆。
- hook 从 stdin 读取工具调用载荷，与内置可读规则（`scripts/guard.js`）匹配；除插件数据目录的决策日志和 `session-roots.log` 外不写任何文件。

## 局限

不是 OS 级沙箱：编码载荷（`powershell -EncodedCommand`）、脚本文件内容（`powershell -File`、`node x.js`）、载荷里没有路径字面量的写入（变量拼接、间接 `child_process` 执行）、敏感文件读取/外带和网络访问都不在能力范围内。防误操作，不防恶意绕过。

## License

[MIT](https://github.com/Momenttttt/zcode-fence/blob/main/LICENSE) © 2026 zcode-fence contributors

灵感来自 [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard)（MIT）；设计思路另参考了 [leepokai/jev-guard](https://github.com/leepokai/jev-guard)、[kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) 与 [openchamber/openchamber](https://github.com/openchamber/openchamber)，仅吸收思路，未复制代码。

---

**简体中文** ｜ [English](README.md)
