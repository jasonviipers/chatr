import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { z } from 'zod';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  USERNAME_PATTERN,
} from '../auth/auth.ts';

/** Messages mirror the previous API ("Username is required", "... length must be at least N ...") */
const required = (label: string) => ({
  error: (issue: { input?: unknown }) =>
    issue.input === undefined
      ? `${label} is required`
      : `${label} must be a string`,
});

export const usernameField = z
  .string(required('Username'))
  .min(
    USERNAME_MIN,
    `Username length must be at least ${USERNAME_MIN} characters long`,
  )
  .max(
    USERNAME_MAX,
    `Username length must be less than or equal to ${USERNAME_MAX} characters long`,
  )
  .regex(
    USERNAME_PATTERN,
    'Username must only contain alpha-numeric characters',
  );

/** Strength rules apply when a password is chosen, not when an existing one is typed at sign-in. */
export const newPasswordField = z
  .string(required('Password'))
  .min(
    PASSWORD_MIN,
    `Password length must be at least ${PASSWORD_MIN} characters long`,
  )
  .max(
    PASSWORD_MAX,
    `Password length must be less than or equal to ${PASSWORD_MAX} characters long`,
  );

export const signInPasswordField = z
  .string(required('Password'))
  .min(1, 'Password is not allowed to be empty')
  .max(PASSWORD_MAX, 'Invalid credentials');

export const nameField = z
  .string(required('Name'))
  .trim()
  .min(3, 'Name length must be at least 3 characters long')
  .max(30, 'Name length must be less than or equal to 30 characters long');

export const idField = z
  .number(required('Id'))
  .int('Id must be an integer')
  .positive('Id must be a positive number');

/** `zValidator` that answers 422 `{ message }` with the first problem, like the previous API. */
export function validate<
  T extends z.ZodType,
  Target extends keyof ValidationTargets,
>(target: Target, schema: T) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const message = result.error.issues[0]?.message ?? 'Invalid request';
      return c.json({ message }, 422);
    }
    return undefined;
  });
}
