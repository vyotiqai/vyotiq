---
title: Slash commands
description: Use all 13 built-in commands and understand dynamic commands from skills, MCP prompts, rules, and command files.
section: customize
order: 8
type: reference
audience: Keyboard-oriented users
related:
  - customize/skills
  - customize/mcp
  - agent/modes
---

Type / in the composer to search available commands. Built-ins can change the app or run directly; dynamic entries can send an expanded prompt.

## Built-in commands

| Command | Behavior |
| --- | --- |
| /clear | Start a fresh chat for a new task boundary |
| /compact | Summarize older messages to free context space; trailing text can guide compaction |
| /marketplace | Browse and manage skills, MCP servers, and packages |
| /settings | Open application settings |
| /create-rule | Create a workspace rule under .vyotiq/rules/ |
| /create-skill | Create under .vyotiq/skills/; add personal for personal scope |
| /help | Send a generated list of currently available commands |
| /undo | Restore files from the latest agent-write checkpoint for this run |
| /ask | Switch to Ask mode |
| /plan | Switch to Plan mode |
| /agent | Switch to Agent mode |
| /harness-review | Mine recent run receipts into a harness proposal draft |
| /harness-apply | Confirm and apply the latest or named harness proposal |

There are 13 built-in slash commands.

## Dynamic command sources

The menu can also include:

- enabled local or Marketplace skills;
- MCP prompts advertised by connected servers;
- requestable rules;
- supported command files discovered for the workspace.

Availability can therefore change when you switch workspaces, connect an MCP server, create a skill, or edit rules. /help is generated from commands that are ready at that moment and limits its output to 40 entries.

## Syntax

Select a menu item or type its trigger and optional trailing text. For example:

/compact Keep the accepted API decision and the failing test name.

Client commands such as /settings open a view instead of sending text to the model. Mode commands retain the current chat. /clear creates the fresh task boundary.

Slash commands do not bypass mode policy, tool approval, or confirmation steps. /harness-apply, for example, remains human-confirmed.
