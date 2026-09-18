# zcode-fence

**A deterministic fence plugin for ZCode: catastrophic-command gate + project write fence. Windows-first, works on all three platforms, ask-only, zero dependencies (Node ≥ 16).**

When you run ZCode in "full access" mode, what you need is not another permission level but a **deterministic pre-flight guard**: if the AI accidentally runs `rm -rf C:/Users` or writes files to your desktop/home, ask first. The same command always gets the same verdict — pure rule matching, no AI judgment, no network requests, no third-party dependencies.

## What it guards against: real accidents on Windows

Drive-letter paths, Git Bash path styles, Windows environment variables, the real temp directory — the things most easily missed by macOS-minded tools are foundation-level here:

| Scenario | zcode-fence behavior |
| --- | --- |
| `rm -rf C:/Users` / `echo x > C:/Users/x/pwn.txt` (drive-letter paths, either slash style) | ask |
| `echo x > "C:/Users/…/f"` (quoted redirect target) | quotes stripped, then judged → ask |
| Git Bash / MSYS paths `/c/Users/...`, `echo x > /tmp/f` | normalized to `C:\Users\...`; `/tmp` maps to `%TEMP%` (temp writes pass) |
| Variable paths `%USERPROFILE%` / `$HOME` / `%TEMP%` | expanded before judgment |
| `del /s /q C:\Users\x`, `format D:`, `Remove-Item -Recurse C:\`, `reg delete` on root hives, `cipher /w:`, etc. | built-in rules → ask |
| Compound commands `a && b & c\nd` (incl. single `&`, newlines) | fully split and judged per segment — later segments cannot escape |
| `rm -rf node_modules`, `git reset --hard`, any in-project I/O | pass (zero-false-positive philosophy) |
| Runtime | pure Node (ZCode is an Electron app; node is always present), zero deps, works on a default Windows setup |

## What it does / does not do

Two independent layers:

1. **Danger gate** (`enable_danger_gate`): token-level exact combination matching, catastrophic-only — `rm -rf /`, `rm -rf ~`, `del /s /q C:\Users\x`, `format D:`, `dd of=/dev/sda`, `mkfs`, `diskutil eraseDisk`, fork bombs, `--no-preserve-root`, `chmod -R` on root/home, PowerShell `Remove-Item` on drive roots/home, `reg delete` on root hives, `cipher /w:`, `vssadmin delete shadows`, etc. Custom regex rules supported.
2. **Project fence** (`enable_fence`): file writes are limited to **writable roots** = project root (host-injected `ZCODE_PROJECT_DIR`) + the **real temp dir of the current platform** (`TEMP`/`TMP` on Windows; `TMPDIR` with `/tmp` kept on Unix) + the ZCode project memory directory (`~/.zcode/cli/memories`, written frequently by the host memory feature, allowed by default) + user-configured extra roots. Bash commands are judged heuristically (redirect targets, destination positions of cp/mv/tar/curl/tee...); file tools (Write/Edit/ApplyPatch) get exact judgment (realpath with per-segment ancestor walk against symlink smuggling).

**Zero-false-positive philosophy**: in-project behavior is governed by your own prompts; the plugin only cares about "catastrophe" and "out-of-bounds".

**Non-goals (honest disclosure)**: this is not an OS-level sandbox. It inspects command text before execution; the following evade it by nature (it protects against accidents, not deliberate circumvention):

- writes inside scripts (`python -c "open('/etc/x','w')"`), encoded payloads (`powershell -EncodedCommand`), script file contents (`powershell -File x.ps1`);
- `cd` out of the project then write relatively (`cd /c/Users/x && touch y` passes — documented blind spot);
- network access (ZCode's plugin API cannot control it).

## ask-only: only tighten, never loosen (the key design decision)

A hook's `allow` only skips the host's routine confirmation — it can only make things looser, never safer. So this plugin **never emits `allow`** (and never `deny`): on violation it emits `ask`; otherwise no output and exit 0, handing control back to the host's own permission mode. `ask` takes precedence over the host mode — even under full access a confirmation dialog appears. The confirmation box is the elevation channel: approve once, pass once.

| Host mode | Normal in-project ops | Dangerous cmd / out-of-bounds write | Net effect |
| --- | --- | --- | --- |
| Full access (main scenario) | silence = runs as usual | confirmation | full fence |
| Auto edit | silence = host default | confirmation (Bash already asks) | semantics unchanged, free out-of-bounds file-write protection |
| Confirm before changes | silence = host still asks each step | confirmation (overlaps host prompt) | equivalent to not installed |
| Plan mode | unchanged | unchanged | unchanged |

## Installation

**Option 1: local directory marketplace (development / personal use)**

1. ZCode → Plugins → Add marketplace → select this repo root (the repo root itself is the local marketplace via `marketplace.json`);
2. Install `zcode-fence` from that marketplace.

**Option 2: GitHub marketplace (once the repo is pushed to GitHub)**

1. ZCode → Plugins → Add marketplace → enter the repo URL `https://github.com/Momenttttt/zcode-fence`;
2. Install `zcode-fence` from that marketplace.

After either method, **start a new task** (hook config is snapshotted at task start; installs and config changes only take effect in new tasks), then ask the agent to run `echo x > C:/Users/<you>/Desktop/fence-test.txt` — a confirmation dialog means it works.

## Configuration

Configured in the ZCode plugin settings UI, persisted under `plugins.options["zcode-fence@<marketplace>"]` in `~/.zcode/cli/config.json`, **re-read on every tool call** (takes effect in new tasks after editing). The settings UI is a single-line input that strips newlines → all list-type values are semicolon-separated; regex segments must not contain semicolons.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `enable_danger_gate` | boolean | `true` | Danger gate switch |
| `enable_fence` | boolean | `true` | Project fence switch |
| `custom_rules` | string | `""` | Custom danger rules: semicolon-separated JS regexes (case-sensitive), matched against the whole command text; invalid segments are skipped |
| `extra_writable_roots` | string | `""` | Extra writable roots: semicolon-separated, supports `~`, `$VAR`, `%VAR%`. Add the other folders of multi-folder projects here (the host provides no folder list, so they cannot be inferred) |
| `enable_log` | boolean | `true` | Decision log switch |

## CLI self-test & decision log

Print verdicts without ZCode (stdout is byte-identical to hook output; human summary goes to stderr):

```bash
export ZCODE_PROJECT_DIR="$PWD"
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf C:/Users'         # → ask (danger gate)
node plugins/zcode-fence/scripts/guard.js --eval 'echo x > "C:/Users/x/f"' # → ask (out of bounds)
node plugins/zcode-fence/scripts/guard.js --eval 'rm -rf node_modules'     # → silent
node plugins/zcode-fence/scripts/guard.js --eval-write 'C:\Users\x\Desktop\a.txt'  # → ask
node plugins/zcode-fence/scripts/guard.js --help
```

The decision log (on by default) writes one JSONL line per ask/silent/error to `~/.zcode/cli/plugins/data/zcode-fence@<marketplace>/decisions.log` (auto-rotates at 5MB) for after-the-fact auditing ("why wasn't that blocked?"). Invalid stdin or internal errors fail open (exit 0, no output) and are logged.

See [SKILL.md](plugins/zcode-fence/skills/zcode-fence/SKILL.md) for how the agent should respond to `[zcode-fence: ...]` markers: switch to an in-project/temp path or request user approval; never retry verbatim, never try to bypass.

## Security statement

- No network activity; no data collection; all decisions are local and auditable (decision log).
- All rules are built-in and readable (`plugins/zcode-fence/scripts/guard.js`); no remote rule delivery.

## Development & testing

```bash
npm test   # node tests/unit.js && node tests/run.js
```

- `tests/unit.js`: unit tests for normalizePath / splitting / token extraction / danger targets / config;
- `tests/run.js`: acceptance cases (`tests/cases.json`) all exercise the real entry points (`--eval` / stdin), with global invariants: **no case may ever produce allow/deny output** (ask-only is a project-level decision), ask output must exactly match the host schema, and marketplace.json/plugin.json versions must stay in sync;
- CI: GitHub Actions tri-platform matrix (windows/ubuntu/macos + a node16 compatibility job).

Release reminder: bump `version` in both `marketplace.json` and `plugins/zcode-fence/.zcode-plugin/plugin.json` together (enforced by a test).

## License

[MIT](LICENSE) © 2026 zcode-fence contributors

Inspired by [XieZongChen/zcode-workspace-guard](https://github.com/XieZongChen/zcode-workspace-guard) (MIT).
