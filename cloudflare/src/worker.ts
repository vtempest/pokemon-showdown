/**
 * Pokémon Showdown on Cloudflare Workers.
 *
 * HTTP API (JSON):
 *
 *   GET  /                                web client (sign in, lobby, battles, ladder)
 *   *    /api/auth/*                      better-auth (sign in with Google / as guest, sessions)
 *   GET  /api/config                      enabled sign-in methods
 *   GET  /api/formats                     list of supported formats
 *   POST /api/users          {name}       claim a Showdown name for the signed-in account
 *   GET  /api/me                          the signed-in account and its name
 *   POST /api/teams/validate {format, team}
 *   POST /api/teams/generate {format}     random team for Random Battle formats
 *   POST /api/battles        {format, team?, opponent?, rated?}   create a battle (you are p1)
 *   POST /api/battles/:id/join {team?}    join as p2; the battle starts immediately
 *   GET  /api/battles        ?status=&format=&user=&limit=
 *   GET  /api/battles/:id                 battle details (with the log/replay)
 *   GET  /api/battles/:id/ws              WebSocket for playing or spectating
 *   GET  /api/ladder/:format              ladder for a format
 *
 * Authenticated endpoints use the better-auth session cookie, or the session
 * token as `Authorization: Bearer <token>` (or `?token=` for WebSockets).
 */

import { toID } from '../../sim/dex';
import { enabledProviders, getAuth, getViewer, validateName, type Viewer } from './auth';
import { createUser, getBattle, getLadder, listBattles, type UserRow } from './db';
import type { Env } from './env';
import { generateTeam, listFormats, validateTeam } from './sim';
import CLIENT_HTML from './client/index.html';

export { BattleRoom } from './battle-room';

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

const JSON_HEADERS = {
	'Content-Type': 'application/json; charset=utf-8',
	'Access-Control-Allow-Origin': '*',
};
const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	'Access-Control-Max-Age': '86400',
};

function json(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
	} catch {}
	throw new HttpError(400, `Expected a JSON object body.`);
}

async function requireViewer(request: Request, env: Env): Promise<Viewer> {
	const viewer = await getViewer(request, env);
	if (!viewer) throw new HttpError(401, `You must be signed in.`);
	return viewer;
}

/** A signed-in account that has claimed a Showdown name */
async function requirePlayer(request: Request, env: Env): Promise<UserRow & { guest: boolean }> {
	const viewer = await requireViewer(request, env);
	if (!viewer.profile) throw new HttpError(403, `Choose a name first (POST /api/users).`);
	return { ...viewer.profile, guest: viewer.isGuest };
}

function randomId(length: number) {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	return [...crypto.getRandomValues(new Uint8Array(length))].map(byte => alphabet[byte % alphabet.length]).join('');
}

function battleStub(env: Env, id: string) {
	if (!/^[a-z0-9]{1,64}$/.test(id)) throw new HttpError(404, `Battle not found.`);
	return env.BATTLES.get(env.BATTLES.idFromName(id));
}

function unwrap<T>(result: { ok: true, value: T } | { ok: false, error: string }): T {
	if (!result.ok) throw new HttpError(400, result.error);
	return result.value;
}

function clampLimit(value: string | null, fallback = 50, max = 500) {
	const limit = parseInt(value ?? '');
	return Number.isFinite(limit) && limit > 0 ? Math.min(limit, max) : fallback;
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split('/').filter(Boolean);
	const method = request.method;

	// better-auth handles its own CORS (trustedOrigins)
	if (parts[0] === 'api' && parts[1] === 'auth') return getAuth(env).handler(request);
	if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
	if (!parts.length && method === 'GET') {
		return new Response(CLIENT_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	}
	if (parts[0] !== 'api') throw new HttpError(404, `Not found.`);
	const [, resource, id, action] = parts;

	switch (resource) {
	case 'config':
		if (method === 'GET' && !id) return json({ providers: enabledProviders(env) });
		break;

	case 'formats':
		if (method === 'GET' && !id) return json(listFormats());
		break;

	case 'users':
		if (method === 'POST' && !id) {
			const viewer = await requireViewer(request, env);
			if (viewer.profile) throw new HttpError(409, `You already have the name "${viewer.profile.name}".`);
			const name = validateName((await readBody(request)).name);
			if (!name) throw new HttpError(400, `Names must be 1-18 characters and contain a letter or number.`);
			const userid = toID(name);
			if (!await createUser(env.DB, userid, name, viewer.authUserId)) {
				throw new HttpError(409, `The name "${name}" is already taken.`);
			}
			return json({ userid, name }, 201);
		}
		break;

	case 'me':
		if (method === 'GET' && !id) {
			const viewer = await requireViewer(request, env);
			return json({ ...viewer.profile, email: viewer.email, guest: viewer.isGuest, hasName: !!viewer.profile });
		}
		break;

	case 'teams':
		if (method === 'POST' && id === 'validate') {
			const body = await readBody(request);
			const result = validateTeam(body.format, body.team);
			return json(result.ok ? { valid: true, team: result.value } : { valid: false, error: result.error });
		}
		if (method === 'POST' && id === 'generate') {
			const body = await readBody(request);
			return json({ team: unwrap(generateTeam(body.format)) });
		}
		break;

	case 'ladder':
		if (method === 'GET' && id) {
			return json(await getLadder(env.DB, toID(id), clampLimit(url.searchParams.get('limit'), 100)));
		}
		break;

	case 'battles':
		if (!id) {
			if (method === 'GET') {
				return json(await listBattles(env.DB, {
					status: url.searchParams.get('status') || undefined,
					format: toID(url.searchParams.get('format')) || undefined,
					userid: toID(url.searchParams.get('user')) || undefined,
					limit: clampLimit(url.searchParams.get('limit')),
				}));
			}
			if (method === 'POST') {
				const user = await requirePlayer(request, env);
				const body = await readBody(request);
				const battleId = `${toID(body.format).slice(0, 48)}${randomId(12)}`;
				const players = unwrap(await battleStub(env, battleId).create({
					id: battleId,
					formatid: typeof body.format === 'string' ? body.format : '',
					rated: body.rated !== false,
					player: { userid: user.userid, name: user.name, guest: user.guest },
					team: body.team,
					invited: toID(body.opponent) || null,
				}));
				return json({ id: battleId, players }, 201);
			}
			break;
		}
		if (!action && method === 'GET') {
			const row = await getBattle(env.DB, id);
			if (!row) throw new HttpError(404, `Battle not found.`);
			if (row.status === 'ended') return json(row);
			return json({ ...row, ...await battleStub(env, id).info() });
		}
		if (action === 'join' && method === 'POST') {
			const user = await requirePlayer(request, env);
			const body = await readBody(request);
			const player = { userid: user.userid, name: user.name, guest: user.guest };
			const players = unwrap(await battleStub(env, id).join(player, body.team));
			return json({ id, players });
		}
		if (action === 'ws' && method === 'GET') {
			if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, `Expected a WebSocket upgrade.`);
			// Spectators may connect without signing in; a session identifies players
			const user = (await getViewer(request, env))?.profile;
			const headers = new Headers(request.headers);
			headers.delete('X-PS-Userid');
			headers.delete('X-PS-Name');
			if (user) {
				headers.set('X-PS-Userid', user.userid);
				headers.set('X-PS-Name', user.name);
			}
			return battleStub(env, id).fetch(new Request(request, { headers }));
		}
		break;
	}
	throw new HttpError(404, `Not found.`);
}

export default {
	async fetch(request, env) {
		try {
			return await route(request, env);
		} catch (err) {
			if (err instanceof HttpError) return json({ error: err.message }, err.status);
			console.error(err);
			return json({ error: `Internal server error.` }, 500);
		}
	},
} satisfies ExportedHandler<Env>;
