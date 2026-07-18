---
name: design-loop
description: Create, refine, explain, validate, or publish a Codex Loop from a natural-language task. Use when a user asks to create a loop or workflow, coordinate multiple Codex agents, turn a recurring process into an agent loop, update an existing Loop graph, determine required integrations or secrets, or produce a reusable verified orchestration.
---

# Design Loop

Create or revise a Loop through the `codex-loop` MCP server. Treat the graph as a versioned execution definition, not as a drawing the user must construct.

## Workflow

1. Call `loop_capabilities` before choosing integrations. Treat availability and authentication status as runtime facts.
2. If updating a Loop, call `loop_get`. If creating one, call `loop_create_draft` with the objective and current task id as `originThreadId` when available.
3. Decide whether missing information is consequential. Ask at most three concise questions only when an answer changes safety, external side effects, architecture, access, material cost, or the definition of done. Otherwise state assumptions.
4. Call `loop_designer_message` with the user's complete request plus relevant repository constraints. The Designer compiles the request into a validated revision.
5. Call `loop_validate`. Resolve errors through another Designer message. Report remaining warnings as setup requirements or accepted assumptions.
6. Publish only when the user explicitly asks to save, publish, or make the Loop reusable. Use `loop_publish` and never start it implicitly.
7. Return the Loop deep link, current revision, assumptions, validation state, and unresolved setup requirements.

Never request or transmit a token, password, private key, or secret value. Bind to an authenticated app, MCP server, or verified CLI capability by reference. If none is available, preserve a named setup requirement.

Read [requirements.md](references/requirements.md) when deciding whether to ask questions. Read [workflow-ir.md](references/workflow-ir.md) for node semantics. Read [security.md](references/security.md) whenever the Loop touches credentials, untrusted input, public networks, or external side effects.
