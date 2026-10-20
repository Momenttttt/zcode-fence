# zcode-fence

**A deterministic fence plugin for ZCode: catastrophic-command gate + project write fence. Windows-first, works on all three platforms, ask-only, zero dependencies (Node ≥ 16).**

When you run ZCode in "full access" mode, what you need is not another permission level but a **deterministic pre-flight guard**: if the AI accidentally runs `rm -rf C:/Users` or writes files to your desktop/home, ask first. The same command always gets the same verdict — pure rule matching, no AI judgment, no network activity by default, no third-party dependencies. An optional decision-model review layer can be enabled explicitly for semantic risks rules cannot decide statically.

## What it does

Two independent deterministic layers, plus an optional decision-model review layer that is off by default:

1. **Danger gate** (`enable_danger_gate`): token-level exact combination matching, catastrophic-only — `rm -rf /`, `rm -rf ~`, `del /s /q C:\Users\x`, `format D:`, `dd of=/dev/sda`, `mkfs`, `diskutil eraseDisk`, fork bombs, `--no-preserve-root`, `chmod -R` on root/home, PowerShell `Remove-Item` on drive roots/home, `reg delete` on root hives, `cipher /w:`, `vssadmin delete shadows`, power commands (`shutdown`/`reboot`, `systemctl poweroff`), `bcdedit` writes, `diskpart`, etc. It also sees through payloads hidden inside `trap`/`eval`/`$()`/backticks or behind control-flow keywords such as `then`/`do`, and through interpreter `-e`/`-c` payloads (`node -e`, `python -c`) whenever a write API and an absolute-path literal co-occur (e.g. `node -e "…rmSync('C:/Windows'…)"`). v1.4.0 also covers wrapper option chains and combined short switches, `find -delete`/`-exec` by search root, dynamic `xargs` deletion, `sed -i` operands, shell payloads from `awk`/`php`/`deno`/`bun`/`osascript`, `curl | bash` / `bash <(curl)` / `eval "$(curl)"`, `mount`/`umount`/`fdisk`/`parted` changes, irreversible git operations and system persistence. Custom regex rules supported.
2. **Project fence** (`enable_fence`): file writes are limited to **writable roots** = project root (host-injected `ZCODE_PROJECT_DIR`) + the **real temp dir of the current platform** (`TEMP`/`TMP` on Windows; `TMPDIR` with `/tmp` kept on Unix) + the ZCode project memory directory (`~/.zcode/cli/memories`) + user-configured extra roots. Bash commands are judged heuristically (redirect targets, destination positions of cp/mv/tar/curl/tee..., every path operand of `chmod`/`chown`, both sides of `mv`, `sed -i` operands, the deletion root of `find`, path literals co-occurring with write APIs inside interpreter payloads); `cd`/`pushd`/`popd` update the current directory for later segments, and relative write targets are resolved against it before comparing with the writable roots; file tools (Write/Edit/ApplyPatch) get exact judgment (realpath with per-segment ancestor walk against symlink smuggling).

**Session-root locking** (`lock_session_root`): the host-injected project root actually tracks the Bash current directory — once the agent `cd`s into a subdirectory, every subsequent call (Write/Edit included) drifts along, and `cd`-ing out of the project disables the fence entirely. With locking on, each session is judged against the **first root it saw** (≈ the workspace the session opened in): cd-ing into a subdirectory no longer flags writes to the real project root, and writes after cd-ing out stay fenced. State lives in a single `session-roots.log` in the plugin data directory (one line per session, 30-day expiry, 200-entry cap).

**Optional decision-model review layer** (`enable_decision_model`, off by default): only when both deterministic layers stay silent, the tool name, command or file path, and the project root are sent to the configured model with one question (should the user confirm?) plus an effect category. The model can only produce ask or silence; confirmation fires at the configured threshold (default 0.6). Timeouts (default 3500 ms, capped at 4000 ms), network errors, invalid responses or a missing endpoint fail open and are logged. Secrets are redacted before sending; file contents, conversation history and session memory are never sent; no vendor endpoint is hardcoded.

Drive-letter paths (either slash style), Git Bash / MSYS paths (`/c/Users/...`), Windows environment variables (`%USERPROFILE%`, `$HOME`) and the real temp directory are foundation-level capabilities, not afterthoughts.

**Zero-false-positive philosophy**: routine in-project work (`rm -rf node_modules`, `mv src/a.ts src/b.ts`, in-project `chmod +x`, ...) passes untouched; the plugin only cares about "catastrophe", "out-of-bounds" and "irreversible loss". Git is the deliberate exception: operations that can lose uncommitted changes, untracked files, remote branches/tags or history ask even inside the project.

## ask-only: only tighten, never loosen

A hook's `allow` only skips the host's routine confirmation — it can only make things looser, never safer. So this plugin **never emits `allow`** (and never `deny`): on violation it emits `ask`; otherwise no output and exit 0, handing control back to the host's own permission mode. `ask` takes precedence over the host mode — even under full access a confirmation dialog appears. The confirmation box is the elevation channel: approve once, pass once.

**Non-goals (honest disclosure)**: this is not an OS-level sandbox. It inspects command text before execution and protects against accidents, not deliberate circumvention (encoded payloads, script file contents such as `node x.js`, writes whose payload carries no path literal (including commands assembled from variables and executed indirectly), sensitive-file reads/exfiltration, and network access are out of reach — documented blind spots. Relative out-of-bounds writes are now covered by in-command cwd tracking (`cd /c/Users/x && touch y` asks), while cd-ing into a writable root such as the temp directory still passes by design).

## Installation

1. ZCode → Plugins → Add marketplace → enter the repository URL `https://github.com/Momenttttt/zcode-fence` (or select a local clone's root — the repo root itself is a marketplace via `marketplace.json`);
2. Install `zcode-fence` from that marketplace;
3. **Start a new task** (hook config is snapshotted at task start; installs only take effect in new tasks), then ask the agent to run `echo x > C:/Users/<you>/Desktop/fence-test.txt` — a confirmation dialog means it works.

## Configuration

Configured in the ZCode plugin settings UI, persisted under `plugins.options["zcode-fence@<marketplace>"]` in `~/.zcode/cli/config.json`, **re-read on every tool call** (takes effect immediately; only install/enable changes need a new task).

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enable_danger_gate` | boolean | `true` | Danger gate switch |
| `enable_fence` | boolean | `true` | Project fence switch |
| `lock_session_root` | boolean | `true` | Session-root locking: judge against each session's first-seen root and ignore cd drift — no false positives after cd-ing into subdirectories, no fence bypass after cd-ing out. State in session-roots.log |
| `custom_rules` | string | `""` | Custom danger rules: semicolon-separated JS regexes (case-sensitive), matched against the whole command text; invalid segments are skipped |
| `extra_writable_roots` | string | `""` | Extra writable roots: semicolon-separated, supports `~`, `$VAR`, `%VAR%`. Add the other folders of multi-folder projects here |
| `enable_log` | boolean | `true` | Decision log switch |
| `enable_decision_model` | boolean | `false` | Decision-model review (off by default; no network requests while off) |
| `decision_model_endpoint` | string | `""` | Full POST endpoint; https, or http on localhost/private networks |
| `decision_model_model` | string | `""` | `model` field; omitted when empty |
| `decision_model_api_key` | string | `""` | Bearer key; `ZCODE_FENCE_DECISION_MODEL_API_KEY` wins |
| `decision_model_threshold` | string | `"0.6"` | Confirmation probability threshold, 0–1 |
| `decision_model_timeout_ms` | string | `"3500"` | Timeout in ms, capped at 4000 |
| `decision_model_headers` | string | `""` | Extra headers, semicolon-separated `Name: Value` |
| `decision_model_proxy` | string | `""` | `http://` proxy; NO_PROXY/localhost bypass |
| `decision_model_prompt` | string | `""` | Optional prompt override |

## CLI self-test & decision log

Print verdicts without ZCode. stdout is byte-identical to hook output; stderr gets a one-line human-readable summary:

```bash
export ZCODE_PROJECT_DIR="$PWD"
node scripts/guard.js --eval 'rm -rf C:/Users'         # → ask (danger gate)
node scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask (out of bounds)
node scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node scripts/guard.js --help
```

The decision log (on by default) writes one JSONL line per ask/silent/error to `decisions.log` in the plugin data directory (`ZCODE_PLUGIN_DATA`-based) for after-the-fact auditing. Invalid stdin or internal errors fail open (exit 0, no output) and are logged.

See [SKILL.md](skills/zcode-fence/SKILL.md) for how the agent should respond to `[zcode-fence: ...]` markers: switch to an in-project/temp path or request user approval; never retry verbatim, never try to bypass.

## Data & permissions

- No network activity and no data collection by default; deterministic decisions are local and auditable (decision log).
- Only with `enable_decision_model` explicitly on are redacted tool-call details (tool name, command/path, project root) sent to the configured endpoint; file contents, conversation history and session memory are never sent.
- The hook reads the tool-call payload from stdin, matches it against built-in readable rules (`scripts/guard.js`), and writes nothing except the decision log in the plugin data directory.

## License

[MIT](https://github.com/Momenttttt/zcode-fence/blob/main/LICENSE) © 2026 zcode-fence contributors

Design ideas were informed by [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard) (MIT), [leepokai/jev-guard](https://github.com/leepokai/jev-guard), [kenryu42/cc-safety-net](https://github.com/kenryu42/cc-safety-net) and [openchamber/openchamber](https://github.com/openchamber/openchamber); ideas only, no code copied.

---

[简体中文](README_CN.md) ｜ **English**
