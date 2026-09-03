# guardrail

A stupid safety net for catastrophic bash commands. It inspects every `bash`
tool call and blocks the obvious disasters before they run.

## What it blocks

| Category | Examples |
|----------|----------|
| `rm` on a fatal target | `rm -rf ~`, `rm -rf /`, `rm -rf /*`, `rm -rf $HOME`, `rm -rf /usr`, `rm -rf .git` |
| unset-variable wipes | `rm -rf $BUILD_DIR`, `rm -rf $DIR/out` (expands under `/` when unset) |
| recursive permission changes | `chmod -R 777 /`, `chown -R user ~` |
| raw device writes | `dd of=/dev/rdisk0`, `echo x > /dev/sda`, `mkfs.ext4 ...`, `diskutil eraseDisk` |
| shell self-harm | fork bombs, `curl ... \| sh`, `wget ... \| sudo -E bash` |
| machine control | `shutdown`, `reboot`, `halt`, `poweroff`, `systemctl poweroff`, `init 0` |

The real command is resolved past wrappers and shell structure: `sudo`/`doas`
(including value options like `sudo -u root`), `env`, `nice`, `xargs`,
`timeout`, `nohup`, `command`, `exec`, leading `VAR=value` assignments,
absolute paths (`/bin/rm`), `if`/`for` bodies, `( ... )` groups, and
`sh -c '...'` payloads (up to 3 levels deep).

Targets are expanded before they are classified: `~`, `$HOME`, `${HOME}`,
`..` segments, trailing slashes, and relative paths (resolved against the
bash tool's own `cwd` when it supplies one).

Quoted text and `#` comments are inert, so `echo 'rm -rf ~ is bad'` and
`rg 'curl .* | sh' docs/` are not blocked. Normal work is untouched:
`rm -rf node_modules`, `xargs rm -rf`, `chmod -R 755 ./scripts`,
`dd of=./disk.img`, `rm -rf $TMPDIR` all pass.

## Command

```
/guardrail              # show state
/guardrail off          # disable for this session
/guardrail on           # re-enable
/guardrail rm -rf ~     # dry-run a command against the rules
```

Set `PI_GUARDRAIL=off` to start with it disabled.

## Caveats

This is not a security boundary. Matching is token-based, not a real shell
parse, so plenty slips through: `eval`, base64 payloads, a destructive script
file, `find / -delete`, `mv ~ /tmp`, `> ~/.zshrc`, a `cd` earlier in the
pipeline that changes what a relative target means, and anything a language
runtime does (`python -c 'shutil.rmtree("/")'`). System subtrees are not
protected either, only the top-level directories themselves: `rm -rf /usr`
blocks, `rm -rf /usr/bin` does not.

It catches mistakes, not adversaries.
