# zcode-fence

**A deterministic fence plugin for ZCode: catastrophic-command gate + project write fence. Windows-first, works on all three platforms, ask-only, zero dependencies (Node ≥ 16).**

When you run ZCode in "full access" mode, what you need is not another permission level but a **deterministic pre-flight guard**: if the AI accidentally runs `rm -rf C:/Users` or writes files to your desktop/home, ask first. The same command always gets the same verdict — pure rule matching, no AI judgment, no network requests, no third-party dependencies.

## What it does

Two independent layers:

1. **Danger gate** (`enable_danger_gate`): token-level exact combination matching, catastrophic-only — `rm -rf /`, `rm -rf ~`, `del /s /q C:\Users\x`, `format D:`, `dd of=/dev/sda`, `mkfs`, `diskutil eraseDisk`, fork bombs, `--no-preserve-root`, `chmod -R` on root/home, PowerShell `Remove-Item` on drive roots/home, `reg delete` on root hives, `cipher /w:`, `vssadmin delete shadows`, etc. Custom regex rules supported.
2. **Project fence** (`enable_fence`): file writes are limited to **writable roots** = project root (host-injected `ZCODE_PROJECT_DIR`) + the **real temp dir of the current platform** (`TEMP`/`TMP` on Windows; `TMPDIR` with `/tmp` kept on Unix) + the ZCode project memory directory (`~/.zcode/cli/memories`) + user-configured extra roots. Bash commands are judged heuristically (redirect targets, destination positions of cp/mv/tar/curl/tee...); file tools (Write/Edit/ApplyPatch) get exact judgment (realpath with per-segment ancestor walk against symlink smuggling).

Drive-letter paths (either slash style), Git Bash / MSYS paths (`/c/Users/...`), Windows environment variables (`%USERPROFILE%`, `$HOME`) and the real temp directory are foundation-level capabilities, not afterthoughts.

**Zero-false-positive philosophy**: in-project behavior (`rm -rf node_modules`, `git reset --hard`, ...) passes untouched; the plugin only cares about "catastrophe" and "out-of-bounds".

## ask-only: only tighten, never loosen

A hook's `allow` only skips the host's routine confirmation — it can only make things looser, never safer. So this plugin **never emits `allow`** (and never `deny`): on violation it emits `ask`; otherwise no output and exit 0, handing control back to the host's own permission mode. `ask` takes precedence over the host mode — even under full access a confirmation dialog appears. The confirmation box is the elevation channel: approve once, pass once.

**Non-goals (honest disclosure)**: this is not an OS-level sandbox. It inspects command text before execution and protects against accidents, not deliberate circumvention (writes inside scripts, encoded payloads, `cd` out then write relatively, and network access are out of reach — documented blind spots).

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
| `custom_rules` | string | `""` | Custom danger rules: semicolon-separated JS regexes (case-sensitive), matched against the whole command text; invalid segments are skipped |
| `extra_writable_roots` | string | `""` | Extra writable roots: semicolon-separated, supports `~`, `$VAR`, `%VAR%`. Add the other folders of multi-folder projects here |
| `enable_log` | boolean | `true` | Decision log switch |

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

- No network activity; no data collection; all decisions are local and auditable (decision log).
- The hook reads the tool-call payload from stdin, matches it against built-in readable rules (`scripts/guard.js`), and writes nothing except the decision log in the plugin data directory.

## License

[MIT](https://github.com/Momenttttt/zcode-fence/blob/main/LICENSE) © 2026 zcode-fence contributors

Inspired by [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard) (MIT).

---

[简体中文](README_CN.md) ｜ **English**
