<p align="center"><img src="assets/icon.png" width="120" alt="zcode-fence icon"></p>

<p align="center"><a href="README.md">简体中文</a> ｜ <strong>English</strong></p>

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

> This is not the full list. Every rule lives in [`guard.js`](plugins/zcode-fence/scripts/guard.js) as readable tables, with acceptance cases alongside. The README only shows the shapes that hurt most.

## Windows is the foundation, not an afterthought

Drive-letter paths (either slash style), Git Bash / MSYS paths (`/c/Users/...`), Windows environment variables (`%USERPROFILE%`, `%TEMP%`, `$HOME`), quoted redirect targets, the real temp directory — details that Unix-minded tools miss are normalized here before any judgment. On Windows, `/tmp` maps to the real `%TEMP%`, so temp writes do not raise false alarms.

## How it works: two deterministic layers plus one optional layer

| Layer | Switch | Looks at | On match |
| --- | --- | --- | --- |
| Danger gate | `enable_danger_gate` | Whether the command is catastrophic, irreversible or system-level | ask |
| Project fence | `enable_fence` | Whether the write target is inside the writable roots | ask |
| Decision model (optional) | `enable_decision_model`, off by default | Semantic risk when both layers stay silent | ask or silence |

The two deterministic layers are independent. Turn the danger gate off and `rm -rf /` is still caught by the fence as an out-of-bounds write.

### Danger gate

Catastrophic, irreversible and system-level changes only; routine in-project deletions pass. Before judging, it peels off:

- **Wrappers**: `env`, `sudo`, `nice`, `timeout`, `stdbuf`, `nohup`, `time`, `command`, `exec`, `strace`, `wsl`, skipping option chains and combined short switches (e.g. `bash -lc`);
- **Shell and control flow**: `bash -c`, `powershell -Command`, `trap`, `eval`, `$()`, backticks, commands behind `then` / `do`;
- **Inline interpreter scripts**: `node -e`, `python -c`, `php -r`, `deno eval`, `bun -e`, `awk system()`, `osascript` — blocked when a write API and an absolute-path literal co-occur.

Add your own rules with `custom_rules` (semicolon-separated JS regexes).

### Project fence

Writes are limited to four writable roots:

1. The project root (host-injected `ZCODE_PROJECT_DIR`);
2. The current platform's real temp directory (`TEMP` / `TMP` on Windows; `TMPDIR` with `/tmp` kept on Unix);
3. The ZCode project memory directory (`~/.zcode/cli/memories`);
4. Extra directories configured in `extra_writable_roots`.

Bash commands are judged heuristically by write targets: redirect targets, destinations of `cp` / `mv` / `tar` / `curl -o` / `tee`, every path operand of `chmod` / `chown`, both source and destination of `mv`, files touched by `sed -i`, the deletion root of `find`. `cd` / `pushd` / `popd` inside a command update the current directory for later segments, and relative paths are resolved against it before comparison. Write / Edit / ApplyPatch get exact judgment: realpath plus a per-ancestor walk to stop symlink smuggling.

### Session-root locking (`lock_session_root`)

The host-injected project root follows the Bash current directory: once the agent `cd`s into a subdirectory, every later call (Write/Edit included) drifts with it, and `cd`-ing out of the project disables the fence entirely. With locking on, each session is judged against the **first root it saw** — roughly the workspace the session opened in. State lives in `session-roots.log` in the plugin data directory (one line per session, 30-day expiry, 200-entry cap).

### Optional decision-model review layer (off by default)

Rules see shape, not intent. When enabled, only after both deterministic layers stay silent are the tool name, command or path, and project root sent to the configured model, with one question: should the user confirm this? The model can only answer ask or silence; confirmation appears when the probability reaches the threshold (default 0.6).

A missing endpoint, a timeout (default 3500 ms, capped at 4000 ms), a network error or an invalid response all fail open — the deterministic verdict stands. Secrets (API keys, tokens, passwords, Authorization headers, private-key blocks) are redacted before sending; file contents, conversation history and session memory are never sent. Endpoint, model, key, threshold, timeout, headers, proxy and prompt are all configurable, and the source hardcodes no vendor address.

## ask-only: it only tightens, never loosens

A hook's `allow` only skips the host's routine confirmation — it can make things looser, never safer. So this plugin **never emits `allow`** and never uses `deny`: on a violation it emits `ask`; otherwise no output and exit 0, handing control back to the host's own permission mode. `ask` takes precedence over the host mode, so a confirmation appears even under full access. The dialog is the elevation channel.

| Host mode | Normal in-project work | Dangerous command / out-of-bounds write | Net effect |
| --- | --- | --- | --- |
| Full access (main scenario) | silence, runs as usual | confirmation | full fence |
| Auto edit | silence, host default | confirmation (Bash already asks) | semantics unchanged, free out-of-bounds protection |
| Confirm before changes | silence, host still asks each step | confirmation (overlaps host) | equivalent to not installed |
| Plan mode | unchanged | unchanged | unchanged |

## Installation

**Option 1: GitHub marketplace**

1. ZCode → Plugins → Add marketplace → enter `https://github.com/Momenttttt/zcode-fence`;
2. Install `zcode-fence`.

**Option 2: local directory marketplace (development or personal use)**

1. ZCode → Plugins → Add marketplace → select this repo root (its `marketplace.json` is the local marketplace);
2. Install `zcode-fence`.

**Start a new task** afterwards: hook configuration is snapshotted at task start, so installs and enable/disable changes only apply to new tasks. Then ask the agent to run:

```bash
echo x > C:/Users/<you>/Desktop/fence-test.txt
```

A confirmation dialog means the fence is live.

## Configuration

Edit in the plugin settings UI; values persist under `plugins.options["zcode-fence@<marketplace>"]` in `~/.zcode/cli/config.json`. **Every tool call re-reads the config, so changes apply immediately**; only installs and enable/disable need a new task. The settings UI is a single-line input that strips newlines, so list values are semicolon-separated and regexes must not contain semicolons.

**Basics**

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enable_danger_gate` | boolean | `true` | Danger gate switch |
| `enable_fence` | boolean | `true` | Project fence switch |
| `lock_session_root` | boolean | `true` | Session-root locking: judge against each session's first-seen root and ignore cd drift |
| `custom_rules` | string | `""` | Custom danger rules: semicolon-separated JS regexes (case-sensitive) matched against the whole command; invalid segments are skipped |
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

You can print verdicts without ZCode. stdout is byte-identical to hook output (the ask JSON, or empty when passing), while stderr gets a human-readable summary:

```bash
export ZCODE_PROJECT_DIR="$PWD"
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf C:/Users'         # → ask (danger gate)
node plugins/zcode-fence/scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask (out of bounds)
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node plugins/zcode-fence/scripts/guard.js --eval-write 'C:\Users\x\Desktop\a.txt'  # → ask
node plugins/zcode-fence/scripts/guard.js --help
```

The decision log (on by default) writes one JSONL line per ask/silent/error to `~/.zcode/cli/plugins/data/zcode-fence@<marketplace>/decisions.log`, rotating at 5 MB — useful for answering "why wasn't that blocked?" after the fact. Invalid stdin or internal errors fail open (exit 0, no output) and are still logged.

See [SKILL.md](plugins/zcode-fence/skills/zcode-fence/SKILL.md) for how the agent should respond to `[zcode-fence: ...]` markers: switch to an in-project or temp path, or ask the user to approve; never retry verbatim, never try to bypass.

## Limitations (honest disclosure)

This is not an OS-level sandbox. It looks at command text before execution; it protects against accidents, not deliberate circumvention:

- Encoded payloads (`powershell -EncodedCommand`) and script file contents (`powershell -File`, `node x.js`);
- Writes whose payload carries no path literal (string concatenation, or a command assembled and passed to `child_process`);
- Sensitive-file reads and exfiltration (SSH private keys, `.env`, cloud credentials);
- Network access (ZCode's plugin API cannot control it).

Relative out-of-bounds writes are not in this list: in-command cwd tracking catches `cd /c/Users/x && touch y`, and relative writes after cd-ing into the temp, memory or project directory still go through the writable-root whitelist.

## Development and testing

```bash
npm test   # node tests/unit.js && node tests/run.js && node tests/decision-model.js
```

- `tests/unit.js`: pure-function tests for path normalization, command splitting, token extraction, danger targets and config loading;
- `tests/run.js`: acceptance cases through the real entry points (`--eval` / stdin), plus global invariants — no case may output allow/deny, ask must exactly match the host schema, all three version fields agree, DEFAULT_CONFIG keys match the manifest userConfig;
- `tests/decision-model.js`: a local mock HTTP server covers the decision model's ask/silent/threshold/timeout/HTTP errors/invalid JSON/missing endpoint/redaction, with no external network access.

CI runs a Windows / Ubuntu / macOS matrix plus a Node 16 compatibility job. When releasing, bump `version` in `marketplace.json`, `.zcode-plugin/plugin.json` and `.claude-plugin/plugin.json` together (enforced by a test).

## License

[MIT](LICENSE) © 2026 zcode-fence contributors

Inspired by [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard) (MIT); design ideas were also informed by [leepokai/jev-guard](https://github.com/leepokai/jev-guard), [kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) and [openchamber/openchamber](https://github.com/openchamber/openchamber); ideas only, no code copied.
