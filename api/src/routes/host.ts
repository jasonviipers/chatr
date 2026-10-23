import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../middleware/auth.ts';
import type { AppEnv } from '../lib/http.ts';
import { fail } from '../lib/http.ts';
import {
  idField,
  nameField,
  newPasswordField,
  signInPasswordField,
  usernameField,
  validate,
} from '../lib/validation.ts';
import type { AppDeps } from './deps.ts';
import { accountBody, failIfUsernameTaken, signIn } from './sign-in.ts';

const createHostSchema = z.object({
  name: nameField,
  username: usernameField,
  password: newPasswordField,
});
const signInSchema = z.object({
  username: usernameField.or(
    z.string().min(1, 'Username is not allowed to be empty'),
  ),
  password: signInPasswordField,
});
const idSchema = z.object({ id: idField });

export function hostRoutes(deps: AppDeps) {
  const admin = requireRole(deps.accounts, 'admin');
  const host = requireRole(deps.accounts, 'host');

  return (
    new Hono<AppEnv>()
      .post('/host', admin, validate('json', createHostSchema), async (c) => {
        let created;
        try {
          created = await deps.accounts.createHost(c.req.valid('json'));
        } catch (error) {
          failIfUsernameTaken(error);
        }
        return c.json(accountBody(created), 201);
      })

      .get('/hosts', admin, (c) =>
        c.json(
          deps.accounts.listHosts().map((hostUser) => accountBody(hostUser)),
        ),
      )

      .delete('/host', admin, validate('json', idSchema), async (c) => {
        const deleted = await deps.accounts.deleteHost(c.req.valid('json').id);
        if (!deleted) fail(404, 'Host not found');
        return c.json({ deleted: true });
      })

      .post('/host/signIn', validate('json', signInSchema), async (c) => {
        const { token, user } = await signIn(
          deps,
          c,
          'host',
          c.req.valid('json'),
        );
        return c.json(accountBody(user, token));
      })

      .get('/host/auth', host, (c) => c.json({ authenticated: true }))

      // A host can only stamp their own record (this used to accept any host id)
      .patch('/host/lastMeetingAt', host, validate('json', idSchema), (c) => {
        const { id } = c.req.valid('json');
        if (id !== c.var.user.id) fail(403, 'You are not allowed to do that');
        deps.accounts.touchLastMeeting(id);
        return c.json({ updated: true });
      })
  );
}
