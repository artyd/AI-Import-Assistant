import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth/hook.js';
import { getAiConfig, saveAiConfig } from '../services/aiConfig.js';

/**
 * Per-user AI settings (Phase E — BYOK). Lets a user keep the built-in Штурман
 * Claude for analysis or route the analysis AI step through their own provider
 * key. The raw/encrypted key never leaves the server — GET/PUT return only a
 * masked tail. BYOK applies ONLY to the consolidated-analysis engine; the main
 * agent always uses the built-in Anthropic key.
 */

const putBodySchema = z.object({
  engine: z.enum(['builtin', 'byok']),
  provider: z.enum(['openai', 'gemini', 'claude', 'openrouter']).optional(),
  key: z.string().min(1).max(500).optional(),
});

export async function aiConfigRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);

  // GET /api/ai-config — current user's AI settings (never the raw key).
  app.get('/api/ai-config', async (req, reply) => {
    const view = await getAiConfig(req.user!.sub);
    return reply.send(view);
  });

  // PUT /api/ai-config — switch engine / set BYOK provider + key.
  app.put('/api/ai-config', async (req, reply) => {
    const parsed = putBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const result = await saveAiConfig(req.user!.sub, parsed.data);
    if (!result.ok) {
      // byok_disabled / provider_required / key_required are all client errors.
      return reply.code(400).send({ error: result.error });
    }
    return reply.send(result.view);
  });
}
