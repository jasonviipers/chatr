import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { privacy } from '../db/schema.ts';
import { sanitizePrivacyHtml } from '../lib/sanitize.ts';
import type { AppEnv } from '../lib/http.ts';
import { validate } from '../lib/validation.ts';
import { requireRole } from '../middleware/auth.ts';
import type { AppDeps } from './deps.ts';

const updateSchema = z.object({
  body: z
    .string({
      error: (issue) =>
        issue.input === undefined
          ? 'Body is required'
          : 'Body must be a string',
    })
    .min(1, 'Body is not allowed to be empty')
    .max(
      50_000,
      'Body length must be less than or equal to 50000 characters long',
    ),
});

export function privacyRoutes(deps: AppDeps) {
  const admin = requireRole(deps.accounts, 'admin');

  return new Hono<AppEnv>()
    .get('/privacy', (c) => {
      const row = deps.db.select().from(privacy).limit(1).get();
      return c.json(
        row
          ? {
              id: row.id,
              body: row.body,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            }
          : null,
      );
    })

    .post('/privacy', admin, validate('json', updateSchema), (c) => {
      const body = sanitizePrivacyHtml(c.req.valid('json').body);
      deps.db.transaction((tx) => {
        const existing = tx
          .select({ id: privacy.id })
          .from(privacy)
          .limit(1)
          .get();
        if (existing)
          tx.update(privacy)
            .set({ body })
            .where(eq(privacy.id, existing.id))
            .run();
        else tx.insert(privacy).values({ body }).run();
      });
      return c.json({ updated: true });
    });
}
