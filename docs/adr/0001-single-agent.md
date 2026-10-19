# One Claude agent per chat, tools only

Штурман is a single Claude conversation per chat that acts only through agent tools (`src/agent/`). There is no multi-agent orchestration or sub-agent hand-off in the product runtime, so the behaviour stays predictable and every answer can be traced to tool results. The three chat kinds (normal / supply / consolidated) change the prompt and the tool set; they do not add agents.
