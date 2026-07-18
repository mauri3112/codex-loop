# Capability and secret policy

Prefer an available authenticated app or MCP binding, then a CLI verified inside the Loop runtime. Otherwise create a setup requirement.

Never store secret values in Loop definitions, messages, graph labels, context blocks, logs, or MCP arguments. A secret requirement contains only a name, description, affected nodes, and a provider reference.

Keep agents that read untrusted public content separate from agents with write or deployment authority. Add an approval gate before irreversible external effects.
