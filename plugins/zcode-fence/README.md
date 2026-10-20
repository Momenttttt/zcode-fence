# zcode-fence

**Three hard lines around the AI, even in full-access mode: catastrophic commands, out-of-bounds writes, irreversible loss. It asks; it never decides for you.**

Deterministic rule matching, zero dependencies (Node ≥ 16), no network activity by default. With the optional decision-model layer off, the same command always gets the same verdict. Windows-first, works on macOS and Linux too.

## In 30 seconds

- **Where it sits**: the ZCode PreToolUse hook — one check before every Bash / Write / Edit / ApplyPatch call.
- **What it stops**: catastrophic commands, writes outside the writable roots, irreversible operations (including destructive Git inside the project).
- **How it stops them**: it emits `ask` and shows a confirmation. Never `allow`, never `deny`. Approve once, pass once.
- **What it lets through**: routine in-project work — `rm -rf node_modules`, `mv`, `chmod`, `git status` — silently.
- **What it is not**: not a sandbox, not protection against deliberate circumvention; with the decision model off, it sends nothing over the network.

## What it guards against

| Category | Representative commands (ask on match) |
| --- | --- |
| Catastrophic deletion | `rm -rf /`, `rm -rf ~`, `del /s /q C:\Users` |
| Disk and system damage | `format D:`, `dd of=/dev/sda`, `mkfs`, `diskpart`, `Remove-Item C:\`, `reg delete` on root hives, `vssadmin delete shadows` |
| Power and boot | `shutdown`, `reboot`, `systemctl poweroff`, `bcdedit` boot writes |
| Out-of-bounds writes | `echo x > C:/Users/…/f`, `cp` / `mv` / `tar` / `curl -o` targeting outside the project, Write/Edit to the desktop, home or system directories |
| Irreversible Git | `push --force`, `reset --hard`, `clean -fdx`, `branch -D`, `stash drop/clear`, change-discarding `checkout` / `restore` |
| Remote code execution | `curl … \| bash`, `bash <(curl …)`, `eval "$(curl …)"` |
| System persistence | `crontab -r`, `systemctl enable`, `reg add`, `schtasks /create`, `launchctl load/unload`, disabling the firewall |
| Hidden commands | wrappers such as `env` / `sudo` / `nice` / `timeout`, `bash -lc`, `find -delete` / `-exec`, `xargs rm`, `sed -i`, inline scripts via `node -e` / `python -c` / `php -r` / `awk system()` / `osascript` |

These never trigger a false positive: in-project `rm -rf node_modules`, `mv src/a.ts src/b.ts`, `chmod +x`, `git status`, and writes to the project root, the temp directory or the ZCode memory directory.

> This is not the full list. Every rule lives in [`scripts/guard.js`](scripts/guard.js) as readable tables, with acceptance cases alongside.

## How it works

Two deterministic layers, independent switches, plus one optional layer:

| Layer | Switch | Looks at | On match |
| --- | --- | --- | --- |
| Danger gate | `enable_danger_gate` | Whether the command is catastrophic, irreversible or system-level | ask |
| Project fence | `enable_fence` | Whether the write target is inside the writable roots | ask |
| Decision model (optional) | `enable_decision_model`, off by default | Semantic risk when both layers stay silent | ask or silence |

**Danger gate** peels off wrappers (`env`, `sudo`, `nice`, `timeout`, `stdbuf`, `nohup`, `time`, `command`, `exec`, `strace`, `wsl`), shell layers (`bash -c`, `powershell -Command`, `trap`, `eval`, `$()`, backticks, commands behind `then` / `do`) and inline interpreter scripts (`node -e`, `python -c`, `php -r`, `deno eval`, `bun -e`, `awk system()`, `osascript`) before judging. Add rules with `custom_rules`.

**Project fence** limits writes to four roots: the project root (host-injected `ZCODE_PROJECT_DIR`), the real temp directory (`TEMP` / `TMP` on Windows; `TMPDIR` with `/tmp` kept on Unix), the ZCode memory directory (`~/.zcode/cli/memories`) and any `extra_writable_roots`. Bash commands are judged by redirect targets, destinations of `cp` / `mv` / `tar` / `curl -o` / `tee`, `chmod` / `chown` operands, `sed -i` files and `find` deletion roots; `cd` / `pushd` / `popd` update the current directory for later segments. File tools get exact realpath judgment with a per-ancestor walk against symlink smuggling.

**Session-root locking** (`lock_session_root`) judges each session against the first root it saw, so `cd`-ing into a subdirectory no longer causes false positives and `cd`-ing out no longer disables the fence. State lives in `session-roots.log` (30-day expiry, 200-entry cap).

**Optional decision-model review** is off by default. Only after both deterministic layers stay silent are the tool name, command or path, and project root sent to the configured model with one question: should the user confirm this? The model can only answer ask or silence; confirmation appears when the probability reaches the threshold (default 0.6). Missing endpoint, timeout, network error or invalid response all fail open and are logged. Secrets are redacted before sending; file contents, conversation history and session memory are never sent; no vendor endpoint is hardcoded.

**Windows is the foundation, not an afterthought**: drive-letter paths (either slash style), Git Bash / MSYS paths (`/c/Users/...`), environment variables (`%USERPROFILE%`, `%TEMP%`, `$HOME`), quoted redirect targets and the real temp directory are normalized before any judgment.

## ask-only: it only tightens, never loosens

A hook's `allow` only skips the host's routine confirmation — it can make things looser, never safer. So this plugin **never emits `allow`** and never uses `deny`: on a violation it emits `ask`; otherwise no output and exit 0, handing control back to the host's own permission mode. `ask` takes precedence over the host mode, so a confirmation appears even under full access.

## Installation

1. ZCode → Plugins → Add marketplace → enter `https://github.com/Momenttttt/zcode-fence` (or select a local clone's root — its `marketplace.json` is the marketplace);
2. Install `zcode-fence`;
3. **Start a new task** (hook config is snapshotted at task start), then ask the agent to run `echo x > C:/Users/<you>/Desktop/fence-test.txt` — a confirmation dialog means it works.

## Configuration

Edit in the plugin settings UI; values persist under `plugins.options["zcode-fence@<marketplace>"]` in `~/.zcode/cli/config.json`. **Every tool call re-reads the config, so changes apply immediately**; only installs and enable/disable need a new task. The settings UI is a single-line input that strips newlines, so list values are semicolon-separated and regexes must not contain semicolons.

**Basics**

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enable_danger_gate` | boolean | `true` | Danger gate switch |
| `enable_fence` | boolean | `true` | Project fence switch |
| `lock_session_root` | boolean | `true` | Session-root locking: judge against each session's first-seen root and ignore cd drift |
| `custom_rules` | string | `""` | Custom danger rules: semicolon-separated JS regexes (case-sensitive), matched against the whole command; invalid segments are skipped |
| `extra_writable_roots` | string | `""` | Extra writable roots: semicolon-separated, supports `~`, `$VAR`, `%VAR%`. Add the other folders of multi-folder projects |
| `enable_log` | boolean | `true` | Decision log switch |

**Decision model**

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enable_decision_model` | boolean | `false` | Review layer switch; no network requests while off |
| `decision_model_endpoint` | string | `""` | Full POST endpoint; must be https, or http on localhost/private networks |
| `decision_model_model` | string | `""` | `model` field in the request body; omitted when empty |
| `decision_model_api_key` | string | `""` | Bearer key; `ZCODE_FENCE_DECISION_MODEL_API_KEY` takes precedence |
| `decision_model_threshold` | string | `"0.6"` | Confirmation probability threshold, 0–1 |
| `decision_model_timeout_ms` | string | `"3500"` | Timeout in ms, capped at 4000 (hook total is 5000) |
| `decision_model_headers` | string | `""` | Extra headers, semicolon-separated `Name: Value` |
| `decision_model_proxy` | string | `""` | `http://` proxy; falls back to environment proxies, NO_PROXY and localhost bypass |
| `decision_model_prompt` | string | `""` | Optional override for the confirmation prompt |

## Self-test and logs

```bash
export ZCODE_PROJECT_DIR="$PWD"
node scripts/guard.js --eval 'rm -rf C:/Users'         # → ask (danger gate)
node scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask (out of bounds)
node scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node scripts/guard.js --help
```

stdout matches hook output exactly; stderr gets a one-line human-readable summary. The decision log (on by default) writes one JSONL line per ask/silent/error to `decisions.log` in the plugin data directory (`ZCODE_PLUGIN_DATA`-based), rotating at 5 MB. Invalid stdin or internal errors fail open and are still logged.

See [SKILL.md](skills/zcode-fence/SKILL.md) for how the agent should respond to `[zcode-fence: ...]` markers: switch to an in-project or temp path, or ask the user to approve; never retry verbatim, never try to bypass.

## Data and permissions

- No network activity and no data collection by default; deterministic decisions are local and auditable.
- Only with `enable_decision_model` on are redacted tool-call details (tool name, command/path, project root) sent to the configured endpoint; file contents, conversation history and session memory are never sent.
- The hook reads the tool-call payload from stdin, matches it against built-in readable rules (`scripts/guard.js`), and writes nothing except the decision log and `session-roots.log` in the plugin data directory.

## Limitations

Not an OS-level sandbox: encoded payloads (`powershell -EncodedCommand`), script file contents (`powershell -File`, `node x.js`), writes with no path literal (variable concatenation, indirect `child_process` execution), sensitive-file reads/exfiltration and network access are outside its reach. It protects against accidents, not deliberate circumvention.

## License

[MIT](https://github.com/Momenttttt/zcode-fence/blob/main/LICENSE) © 2026 zcode-fence contributors

Inspired by [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard) (MIT); design ideas were also informed by [leepokai/jev-guard](https://github.com/leepokai/jev-guard), [kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) and [openchamber/openchamber](https://github.com/openchamber/openchamber); ideas only, no code copied.

---

[简体中文](README_CN.md) ｜ **English**
