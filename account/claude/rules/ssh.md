# SSH Rules

## Authentication

Always use the configured SSH agent or the configured on-disk key. Never pass `-o IdentitiesOnly no`, `-i` with a non-existent path, or any flag that bypasses the configured auth. The global `~/.ssh/config` sets auth for every host it lists. Rely on it, and run `ssh -G <host>` to see the effective settings.

Never add `-o "IdentitiesOnly no"` or otherwise override the key/agent config. If SSH fails with a key error, diagnose the config rather than falling back to password or disabling key restrictions.

## Host Config

All SSH hosts must be in `~/.ssh/config`. If a task requires connecting to a host not already listed, add it before connecting:

```
Host <alias> <ip>
    HostName <ip>
    User <user>
```

Do not connect by raw IP without a config entry. The entry carries the host's user and any host-specific auth, and a bare IP gets only the defaults.

## SSH Binary

Always use the Windows OpenSSH binary: `C:/Windows/System32/OpenSSH/ssh.exe`. Git Bash's bundled `ssh` does not work with the named pipe SSH agent (`//./pipe/openssh-ssh-agent`) and will fail key auth silently. In Bash tool calls, invoke SSH as `/c/Windows/System32/OpenSSH/ssh.exe` (or use the full Windows path).

## SSH Config Location

`~/.ssh/config` resolves to `%USERPROFILE%\.ssh\config` (or `~/.ssh/config` in Git Bash). Its default auth block sits at the end of the file, because ssh keeps the first value it reads for each option and a leading `Host *` would override every per-host setting below it. Machine specifics live in `ssh.local.md`.
