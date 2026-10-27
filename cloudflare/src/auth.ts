/**
 * Accounts, via better-auth (https://better-auth.com) on D1.
 *
 * - Google sign-in, when GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set
 * - Guest sign-in (better-auth's anonymous plugin): guests can play
 *   unrated battles only
 * - Email/password, only when EMAIL_PASSWORD_LOGIN=true (meant for local
 *   development and the end-to-end tests, which can't sign in with Google)
 *
 * Browsers authenticate with better-auth's session cookie. Other clients
 * can send the session token (the `set-auth-token` response header from
 * sign-in) as `Authorization: Bearer <token>`, or `?token=` on WebSockets.
 *
 * A better-auth user is separate from their Showdown name: after signing
 * in, a user claims a name once (`POST /api/users`), stored in `users`.
 */

import { betterAuth } from 'better-auth';
import { anonymous, bearer } from 'better-auth/plugins';
import { toID } from '../../sim/dex';
import { getUserByAuthId, type UserRow } from './db';
import type { Env } from './env';

function createAuth(env: Env) {
	const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {
		google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: 'select_account' as const },
	} : undefined;
	return betterAuth({
		appName: 'Pokémon Showdown',
		database: env.DB,
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.BETTER_AUTH_URL,
		basePath: '/api/auth',
		trustedOrigins: env.TRUSTED_ORIGINS?.split(',').map(origin => origin.trim()).filter(Boolean),
		socialProviders: google,
		emailAndPassword: { enabled: env.EMAIL_PASSWORD_LOGIN === 'true' },
		plugins: [anonymous(), bearer()],
		telemetry: { enabled: false },
	});
}

export type Auth = ReturnType<typeof createAuth>;

let cached: { env: Env, auth: Auth } | null = null;

export function getAuth(env: Env): Auth {
	if (cached?.env !== env) cached = { env, auth: createAuth(env) };
	return cached.auth;
}

export function enabledProviders(env: Env) {
	return {
		google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
		guest: true,
		emailPassword: env.EMAIL_PASSWORD_LOGIN === 'true',
	};
}

export interface Viewer {
	authUserId: string;
	email: string | null;
	isGuest: boolean;
	/** The claimed Showdown name, if any */
	profile: UserRow | null;
}

export async function getViewer(request: Request, env: Env): Promise<Viewer | null> {
	const headers = new Headers(request.headers);
	// Browsers can't set headers on WebSockets, so non-cookie clients pass ?token=
	// (tokens are base64, so restore a `+` that arrived unencoded as a space)
	const token = new URL(request.url).searchParams.get('token')?.replace(/ /g, '+');
	if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);

	const session = await getAuth(env).api.getSession({ headers });
	if (!session) return null;
	const isGuest = !!(session.user as { isAnonymous?: boolean | null }).isAnonymous;
	return {
		authUserId: session.user.id,
		email: isGuest ? null : session.user.email,
		isGuest,
		profile: await getUserByAuthId(env.DB, session.user.id),
	};
}

/** Same rules as the main server: 1-18 characters, at least one alphanumeric */
export function validateName(input: unknown): string | null {
	if (typeof input !== 'string') return null;
	const name = input.replace(/[|,;\s]+/g, ' ').trim();
	if (!name.length || name.length > 18 || !toID(name)) return null;
	return name;
}
