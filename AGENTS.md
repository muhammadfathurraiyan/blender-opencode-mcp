# AGENTS.md

Blender scene sandbox, not a software project. There is no source code, package manifest, build, test, lint, typecheck, or CI. Root contents are `explore-mcp.blend` (binary asset), `opencode.jsonc`, `README.md` (setup guide), `.agents/` (skills), `.gitignore`, and this file. Git is committed on `main` with a GitHub remote; `.DS_Store` and `*.blend1` are ignored.

## Blender access

- All Blender work goes through the `blender` MCP server in `opencode.jsonc`.
- Its command is a stdio bridge run via `uvx` from a git source, not an installed binary. First start downloads and builds (~40s); later starts use uv's cache. Keep the `uvx --from ... blender-mcp` form — replacing it with a bare `blender-mcp` fails with `NotFound: ChildProcess.spawn`.
- Requires Blender running with the Blender Lab **MCP** add-on listening on `127.0.0.1:9876`. Check with `lsof -nP -iTCP:9876 -sTCP:LISTEN` before debugging anything else.
- The community `mcp-for-blender` server is **incompatible** with that add-on (different request types/framing); symptoms are a successful spawn followed by tool calls that hang.
- Prefer purpose-built tools (`get_objects_summary`, screenshots, `render_*`, docs search) over `execute_blender_code`.
- Code passed to `execute_blender_code` runs without inherited imports: start it with `import bpy`. Assign a JSON-serializable dict to `result`; `print` output is discarded.

## Scene edits

- `explore-mcp.blend` is binary — never inspect or modify it by hand, only through the Blender tools.
- Executed code does not save the file. Persist only when asked, via `bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)`.
- Inspect before changing (`get_objects_summary`, `get_object_detail_summary`) and do not destructively modify objects without confirmation.

## Skills

- Skills are project-local, in `.agents/skills/` — not `~/.agents/skills/`. Install from the repo root with `npx skills add <owner/repo@skill> -y`; adding `-g` writes globally instead, which is not wanted here.
- Installed: `blender-mcp` (MCP tool use, `bpy` scripts, GLTF/GLB export and material-loss debugging, GLB optimization) and `blender-modeling` (mesh creation, operators, modifier stacks, bmesh, retopo basics).
- A skill is just a `SKILL.md` with name + description plus optional reference files; nothing runs at install time. It loads when the description matches the task or when named explicitly.
- `blender-mcp` was written for a different server: it says `get_scene_info`, `execute_python`, and port 9876. Map those to this repo's `get_objects_summary`, `execute_blender_code`, and 9876 (unchanged). Follow its guidance, not its tool names.


