# Blender + OpenCode MCP

Drive a running Blender session from [OpenCode](https://opencode.ai) over the Model Context Protocol. `explore-mcp.blend` is a small sample scene (a donut) used to try it out.

Works on macOS; the same steps apply elsewhere, only the `uvx` path differs.

## Requirements

- Blender **5.1+** (tested with 5.2.2)
- Blender Lab **MCP** add-on **1.0.3**
- [`uv`](https://docs.astral.sh/uv/) — provides `uvx`
- OpenCode (CLI, desktop, or VS Code extension)

## 1. Install the Blender add-on

1. In Blender: **Edit → Preferences → Get Extensions**.
2. Add the Blender Lab repository: `https://www.blender.org/lab/mcp-server/`.
3. Install and enable the **MCP** add-on.

The add-on starts a socket server on `localhost:9876` when Blender launches (**Auto Start** is on by default). No add-on or environment credentials are needed.

Verify it is listening:

```sh
lsof -nP -iTCP:9876 -sTCP:LISTEN
```

## 2. Configure OpenCode

The repository's `opencode.jsonc` already contains this. For another project, copy the `mcp` block:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "blender": {
        "type": "local",
        "command": [
          "uvx",
          "--from",
          "git+https://projects.blender.org/lab/blender_mcp.git@v1.0.3#subdirectory=mcp",
          "blender-mcp"
        ]
      }
    }
  }
}
```

This runs the official Blender Lab MCP server over stdio. `uvx` downloads and builds it on first start (~40 s), then reuses its cache.

## 3. Restart OpenCode and connect

MCP servers load at startup, so restart OpenCode after changing `opencode.jsonc`, with Blender already running. Then ask the agent something like:

> List the objects in the current Blender scene.

To confirm by hand, the `blender` server should expose tools such as `get_objects_summary` and `execute_blender_code`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `NotFound: ChildProcess.spawn (blender-mcp)` | The command is not installed. Keep the `uvx --from ...` form from above — a bare `blender-mcp` binary usually does not exist. Install `uv`. |
| Server starts but tool calls hang or time out | Wrong bridge for this add-on. The community `mcp-for-blender` server speaks a different protocol and does not work with the Lab add-on. |
| Works in a terminal but not in the VS Code extension / desktop app | GUI apps on macOS often miss your shell `PATH`. Replace `"uvx"` with its absolute path, e.g. `/opt/homebrew/bin/uvx`. |
| `Connection refused` on port 9876 | Blender is closed or the add-on is not enabled/started. Open Blender and check the port again. |
| Add-on menu shows a start error | Another process is using port 9876. Stop it or change the port in the add-on preferences. |

## Security

`execute_blender_code` runs arbitrary Python inside Blender with no sandbox. Only connect it to models you trust, and keep backups of anything you care about.

The `.blend` file is binary — edit it through Blender, not by hand.
