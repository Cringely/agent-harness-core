# SSH Rules

## Authentication

Always use the SSH agent (1Password, via `//./pipe/openssh-ssh-agent`) or the on-disk key (`~/.ssh/lan_key.pub`). Never pass `-o IdentitiesOnly no`, `-i` with a non-existent path, or any flag that bypasses the configured auth. The global `~/.ssh/config` `Host *` block sets this up correctly — rely on it.

Never add `-o "IdentitiesOnly no"` or otherwise override the key/agent config. If SSH fails with a key error, diagnose the config rather than falling back to password or disabling key restrictions.

## Host Config

All SSH hosts must be in `~/.ssh/config`. If a task requires connecting to a host not already listed, add it before connecting:

```
Host <alias> <ip>
    HostName <ip>
    User <user>
```

Do not connect by raw IP without a config entry — it bypasses the agent/key setup in `Host *`.

## SSH Binary

Always use the Windows OpenSSH binary: `C:/Windows/System32/OpenSSH/ssh.exe`. Git Bash's bundled `ssh` does not work with the named pipe SSH agent (`//./pipe/openssh-ssh-agent`) and will fail key auth silently. In Bash tool calls, invoke SSH as `/c/Windows/System32/OpenSSH/ssh.exe` (or use the full Windows path).

## SSH Config Location

`~/.ssh/config` is at `C:\Users\user\.ssh\config` (or `~/.ssh/config` in Git Bash). The `Host *` block already configures the 1Password agent and key — all hosts inherit it automatically.
