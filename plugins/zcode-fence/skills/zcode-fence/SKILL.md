---
name: zcode-fence
description: How to respond when a permission prompt contains a [zcode-fence: ...] marker — switch to an in-project or temp path, or ask the user to approve. Never retry the same call verbatim and never try to bypass the plugin.
---

# Responding to zcode-fence markers

When a Bash/Write/Edit/ApplyPatch permission prompt contains a reason starting with
`[zcode-fence: ...]`, a deterministic fence rule (or the optional decision-model layer)
flagged the call. The plugin is ask-only: it never allows or denies, it only forces a
confirmation dialog. The user sees the same reason text you do.

There are five marker categories:

- `[zcode-fence: 危险命令]` — the command can cause catastrophic or irreversible loss:
  recursive deletes of roots/home/system directories, disk and partition operations,
  format/wipes, power commands, remote code execution (`curl | bash`, `bash <(curl …)`,
  `eval "$(curl …)"`), irreversible git operations (force/delete/mirror push,
  `reset --hard`, `clean -fdx`, change-discarding checkout/restore, `stash clear/drop`,
  `branch -D`, `tag -d`, …), system persistence changes (crontab, firewall, registry,
  service enable/mask, scheduled tasks), and equivalent payloads hidden in wrappers,
  interpreters, `find`/`xargs`/`sed`, or command substitution.
- `[zcode-fence: 越界写入]` — the write target is outside the writable roots: project
  root, the real temp directory, the ZCode project memory directory
  (`~/.zcode/cli/memories`), and any user-configured extra roots. This includes
  relative targets resolved against the command's current directory (`cd /path && …`),
  `chmod`/`chown` operands, both sides of `mv`, `sed -i` files, `find` deletion roots,
  and interpreter write payloads.
- `[zcode-fence: 路径无法解析]` — the target contains an undefined variable (e.g.
  `%NOPE%\x`), so its owner cannot be determined.
- `[zcode-fence: 自定义规则]` — a user-configured regex matched the command text.
- `[zcode-fence: 决策模型]` — the optional decision-model layer reviewed a call that all
  deterministic rules passed, and recommends confirmation. The reason includes the
  effect category (read-only, project write, git history, data deletion, system change,
  external side effect, exfiltration) and a score.

## What to do

1. **Danger / custom rule**: almost certainly not required by the task. Explain the
   original command and its risk, then use the smallest precise operation instead (for
   example, delete a specific directory inside the project rather than a parent path).
2. **Out-of-bounds write**: prefer, in order:
   - rewrite to a path **inside the project**;
   - put temporary artifacts in the **temp directory** (`%TEMP%` on Windows, `/tmp` in
     Git Bash, `/tmp` or `$TMPDIR` on Unix);
   - if the user explicitly asked for an outside location, keep the path and explain
     why — the user approves it in the dialog. Approval covers that one call.
3. **Unresolvable path**: replace undefined variables with a concrete path.
4. **Decision model**: treat it as a second opinion, not a hard block. Check the reported
   effect category and score, then either switch to a routine in-project approach or
   explain the intended effect to the user and let them decide.
5. If a call is genuinely required as-is, ask the user to approve it. Do not loop on the
   same call.

## Prohibited

- Do not retry the same command or path verbatim — the rules are deterministic and the
  verdict will not change.
- Do not disable, uninstall, reconfigure, or edit the plugin, its manifest, or its
  decision log to get around a marker.
- Do not use `cd` into another directory to hide a relative write; in-command `cd` state
  is tracked and out-of-bounds relative targets are judged. Do not use wrappers,
  interpreters, `xargs`, or `find` to obscure a destructive target — those are unpacked
  and judged too.
- Do not abandon the task after one interception: switching to a compliant path usually
  lets the work continue.
