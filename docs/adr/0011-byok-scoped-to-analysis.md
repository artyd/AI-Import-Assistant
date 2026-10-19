# BYOK is limited to consolidated analysis

Users can store their own AI provider key (OpenAI / Gemini / Claude / OpenRouter), encrypted with AES-256-GCM (`BYOK_ENC_KEY`, table `ai_configs`). Only the consolidated-analysis engine uses it. Штурман always runs on the server's Claude, so the grounding rules and the agent's behaviour do not depend on a user-chosen model.
