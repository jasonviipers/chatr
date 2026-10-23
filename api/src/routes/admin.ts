import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.ts';
import type { AppEnv } from '../lib/http.ts';
import { fail } from '../lib/http.ts';
import {
  newPasswordField,
  signInPasswordField,
  usernameField,
  validate,
} from '../lib/validation.ts';
import type { AppDeps } from './deps.ts';
import {
  failIfUsernameTaken,
  signIn,
  throttleAuthRequests,
} from './sign-in.ts';

const createAdminSchema = z
  .object({
    username: usernameField,
    password: newPasswordField,
    confirmPassword: z.string({ error: 'Confirm password is required' }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Confirm password must be password',
  });

const signInSchema = z.object({
  username: usernameField.or(
    z.string().min(1, 'Username is not allowed to be empty'),
  ),
  password: signInPasswordField,
});

export function adminRoutes(deps: AppDeps) {
  const admin = requireRole(deps.accounts, 'admin');

  return (
    new Hono<AppEnv>()
      // Install check used by the web app: only says whether an administrator exists
      .get('/admin', (c) =>
        c.json(deps.accounts.findAdmin() ? { installed: true } : null),
      )

      // First-run install. Once an administrator exists this stays closed (it used to be open to anyone).
      .post('/admin', validate('json', createAdminSchema), async (c) => {
        throttleAuthRequests(deps, c);
        const { username, password } = c.req.valid('json');
        try {
          const created = await deps.accounts.createFirstAdmin({
            username,
            password,
          });
          if (!created) fail(403, 'Setup is already complete');
        } catch (error) {
          failIfUsernameTaken(error);
        }
        return c.json({ created: true }, 201);
      })

      .post('/admin/signIn', validate('json', signInSchema), async (c) => {
        const { token, user } = await signIn(
          deps,
          c,
          'admin',
          c.req.valid('json'),
        );
        return c.json({
          id: user.id,
          username: user.username,
          accessToken: token,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        });
      })

      .get('/admin/auth', admin, (c) => c.json({ authenticated: true }))
  );
}
