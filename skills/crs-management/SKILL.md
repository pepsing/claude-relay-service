---
name: crs-management
description: Manage a local or Rocky-hosted Codex Relay Service through the installed crsctl CLI, including relay API keys, upstream accounts, connectivity tests, credential refreshes, and usage statistics. Use when Codex is asked to inspect or change CRS operational data with lower context overhead than the CRS MCP server.
---

# CRS Management

Use `crsctl` as the default interface for CRS administration. Prefer it over loading
the CRS MCP tool schemas unless the user explicitly requests MCP.

## Preflight

1. Check the executable without changing state:

   ```bash
   command -v crsctl
   crsctl --version
   crsctl --compact config show
   crsctl --compact capabilities
   ```

2. If configured, verify access with:

   ```bash
   crsctl --compact status
   ```

3. If configuration is missing, ask only for the Rocky base URL. Then run:

   ```bash
   crsctl configure --base-url https://rocky.example.com
   ```

   Let the user enter the `crsm_` management key in the hidden prompt. Never ask
   them to paste the key into chat, and never read the configuration file directly.

The configuration defaults to `~/.config/crsctl/config.json`, is written with mode
`0600`, and may be overridden by `CRS_BASE_URL`, `CRS_MANAGEMENT_KEY`, or
`CRSCTL_CONFIG`.

## Keep output bounded

- Put the global `--compact` option before the subcommand when compact JSON is
  enough.
- `api-keys list` defaults to 10 records. Keep `--page-size` between 1 and 100.
- `accounts list` is server-paginated and defaults to 20 records. Increase
  `--page-size` only when needed.
- Summarize results for the user instead of pasting large JSON responses.
- The client prefers `/admin/management/v1` and automatically falls back to legacy
  admin routes while an older Rocky deployment is being upgraded.

## Inspect CRS

Use the smallest read-only command that answers the request:

```bash
crsctl --compact status
crsctl --compact api-keys list
crsctl --compact api-keys reveal KEY_ID
crsctl --compact accounts types
crsctl --compact accounts list claude --page 1 --page-size 20
crsctl --compact accounts test claude ACCOUNT_ID
crsctl --compact stats summary
crsctl --compact stats api-key KEY_ID --days 7
crsctl --compact stats account claude ACCOUNT_ID --days 7
```

Use `api-keys reveal` only when the user explicitly needs the plaintext relay key.
Do not repeat a returned `cr_` key in commentary or logs.

## Change CRS

Resolve stable IDs and inspect the exact target before changing it.

```bash
crsctl api-keys create --name 'Local agent' --permissions claude,openai
crsctl api-keys update KEY_ID --data '{"description":"updated"}'
crsctl api-keys disable KEY_ID --yes
crsctl api-keys delete KEY_ID --yes
crsctl accounts update claude ACCOUNT_ID --data-file /secure/account-update.json
crsctl accounts refresh claude ACCOUNT_ID
crsctl accounts delete claude ACCOUNT_ID --yes
```

- Only add `--yes` after the user has authorized that exact destructive target.
- API-key creation and reveal responses contain the plaintext `cr_` key. Return it
  to the user only when requested and do not persist it in repository files.
- Prefer `--data-file` for account create/update payloads containing OAuth tokens,
  credentials, passwords, or other secrets. Create any temporary payload file with
  mode `0600`, then remove it after the command completes.
- Do not put sensitive account data in the command-line `--data` argument.

## Handle failures

- `401`: the configured management key is invalid, revoked, or missing.
- `403`: the management API is disabled or blocked by the server/network policy.
- Network errors: verify the base URL and reachability before changing credentials.
- Never print raw request headers, the stored configuration file, or complete
  `crsm_`/`cr_` values while troubleshooting.
