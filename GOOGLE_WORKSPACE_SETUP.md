# Google Workspace (Gmail, Calendar, Tasks, Contacts) for Voxa

Connected 2026-10-19 for ersensari@gmail.com.

- Server: `workspace-mcp==2.0.1` (taylorwilsdon/google_workspace_mcp), started by Pi on demand from
  `data/home/.pi/agent/mcp.json` (`google-workspace`): `--tools gmail calendar tasks contacts --tool-tier core --single-user`,
  `directTools: true` (MiniCPM got lost behind the `mcp` proxy tool and searched 40 times). 10 tools: search/read/send
  Gmail, list calendars, get/manage events, list/get/manage tasks.
- OAuth client: Google Cloud project, "Desktop app" client, its JSON at `data/google-oauth-client.json` (mode 600,
  `GOOGLE_CLIENT_SECRET_PATH`). Consent screen External, **In production** and unverified (personal use; the
  "Google hasn't verified this app" warning is expected). Leave home page / privacy policy / terms empty in Branding:
  filled in, Google starts a brand verification that cannot finish anyway (Gmail send/modify are restricted scopes,
  which need a paid security assessment).
- Token: `data/home/.google_workspace_mcp/credentials/ersensari@gmail.com.json` (refresh token, kept across restarts).
- Contacts adds Google People API access for searching, creating and updating personal contacts. If the existing
  refresh token does not include the contacts scope, Google requires one OAuth consent refresh before those tools
  can work; the existing client ID/secret and token are retained.
- Ports: `WORKSPACE_MCP_PORT`/`PORT` 8765 and `GOOGLE_OAUTH_REDIRECT_URI=http://localhost:8765/oauth2callback` -
  `PORT` matters: the server reads it before `WORKSPACE_MCP_PORT`, and Yulify's own `PORT=4100` leaked in (the
  callback listener ended up on 4101 while Google redirected to 8765).

## Re-authorizing (token revoked or scopes changed)

The consent redirect goes to `localhost:8765` on the server, not on the browser's machine. Run any Workspace tool
from Voxa (or an MCP client in the container); it answers with an authorization URL. Open it, approve, then copy the
browser's failed `http://localhost:8765/oauth2callback?state=...&code=...` address and request the same path on the
server (`curl "http://localhost:8765/oauth2callback?..."`) while that server process is still running.

## What Voxa does with it

`SOUL.md`: only when the user asks in that turn; never checks mail, adds events or changes tasks on its own.
