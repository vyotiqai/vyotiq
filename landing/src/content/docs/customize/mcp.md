---
title: MCP servers
description: Add local or remote MCP servers, configure bearer or OAuth authentication, inspect catalogs, and control workspace use.
section: customize
order: 4
type: guide
audience: Integration users
related:
  - concepts/security
  - troubleshooting/marketplace-mcp
  - reference/tools
---

Agent V can connect MCP servers that expose tools, resources, and prompts. Configure them in Marketplace → Manage → **MCPs**.

## Choose a transport

Use a local command transport for a server process launched on this machine. Use a remote endpoint for an HTTP-based server. Supply only the command, arguments, environment, endpoint, and auth fields the server actually requires.

Remote servers can use a bearer token or OAuth flow. Credentials and tokens belong in the provided auth fields, not in workspace rule or skill text.

## Add and verify a server

1. Open Marketplace → Manage → **MCPs**.
1. Add a server and choose its local or remote transport.
1. Enter its command or endpoint and any required authentication.
1. Save and enable it.
1. Inspect its connection state and advertised tools, resources, and prompts.
1. Start a new Agent step before expecting a changed catalog to appear in the run.

A configured row is not proof of a healthy server. The connection and catalog state must succeed.

## Use MCP content

Built-in MCP meta tools list server catalogs and request or release server tools. Server-reported tools are separate from the app's 59 built-ins.

Ask and Plan may list catalogs only. Invoking an MCP server tool, reading a resource, or fetching a prompt requires Agent mode because server content and side-effect annotations are not trusted as a security gate.

## Scope

Global MCP connections can remain connected for other workspaces. A workspace Force on/off override changes whether runs in that workspace can use an eligible server; it does not necessarily terminate the global connection.

## Safe setup

Treat server output, resources, and prompts as untrusted external content. Review requested filesystem, network, and account access. Keep tool approval enabled when a new server exposes mutating tools.

For connection, import, OAuth, or timeout failures, follow Marketplace and MCP issues.

## Bundled GitHub and Google apps

Marketplace Browse has a Discover row with GitHub, Gmail, Google Drive, and Google Calendar. Add installs the bundled HTTP MCP and opens Connect. Dismiss Connect without signing in and the package stays installed and disconnected. Agent V does not see those MCP tools until connect succeeds.

Add GitHub signs in with OAuth first. Copilot-capable GitHub accounts complete the browser flow. If OAuth fails, paste a GitHub personal access token on the same Connect flow. Native GitHub (gh) pull-request and issue tools stay in the Pull Request panel. GitHub MCP is extra surface for repos, search, Actions, and the GitHub API, not a replacement. After GitHub MCP OAuth or a usable token, Agent V also signs native gh into the same account when the token allows it.

Add Gmail, Google Drive, or Google Calendar needs a Google Cloud Web application OAuth client. Enable the Gmail, Drive, or Calendar APIs plus the matching gmailmcp, drivemcp, or calendarmcp services. Create a Web client and register this exact redirect URI `http://127.0.0.1:19847/oauth/callback` in Google Cloud. Paste the client ID and secret into the first Google Connect wizard. Later Google Adds reuse that shared client. Choose Read only or Read and write before Google consent. Read only uses the readonly Gmail, Drive, or Calendar MCP scopes. Read and write uses the full documented MCP scopes (drafts, file create/update, event create). Changing access later re-runs consent for that product.

## MCP tools protection

MCP tools protection in [Settings → Tools](/docs/reference/settings#tools) defaults on. When it is on, Agent V asks before running MCP server tools even if `Tool approval` is off. Built-in MCP catalog tools still follow `Tool approval`. Turn it off only when MCP tools should follow the global `Tool approval` mode alone. Invoking an MCP server tool still requires Agent mode.
