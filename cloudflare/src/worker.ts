/**
 * Pokémon Showdown on Cloudflare Workers.
 *
 * HTTP API (JSON):
 *
 *   GET  /api/formats                     list of supported formats
 *   POST /api/users          {name}       register a name, returns a bearer token
 *   GET  /api/me                          the logged-in user
 *   POST /api/teams/validate {format, team}
 *   POST /api/teams/generate {format}     random team for Random Battle formats
 *   POST /api/battles        {format, team?, opponent?, rated?}   create a battle (you are p1)
 *   POST /api/battles/:id/join {team?}    join as p2; the battle starts immediately
 *   GET  /api/battles        ?status=&format=&user=&limit=
 *   GET  /api/battles/:id                 battle details (with the log/replay)
 *   GET  /api/battles/:id/ws              WebSocket for playing or spectating
 *   GET  /api/ladder/:format              ladder for a format
 *
 * Authenticated endpoints take `Authorization: Bearer <token>` (or `?token=`).
 */

import { toID } from '../../sim/dex';
import { authenticate, hashToken, randomToken, validateName } from './auth';
import { createUser, getBattle, getLadder, listBattles, type UserRow } from './db';
import type { Env } from './env';
import { generateTeam, listFormats, validateTeam } from './sim';

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

async function requireUser(request: Request, env: Env): Promise<UserRow> {
	const user = await authenticate(request, env.DB);
	if (!user) throw new HttpError(401, `You must be logged in (Authorization: Bearer <token>).`);
	return user;
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

	if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
	if (!parts.length) {
		return json({
			name: 'Pokémon Showdown (Cloudflare Workers)',
			endpoints: ['/api/formats', '/api/users', '/api/battles', '/api/ladder/:format'],
		});
	}
	if (parts[0] !== 'api') throw new HttpError(404, `Not found.`);
	const [, resource, id, action] = parts;

	switch (resource) {
	case 'formats':
		if (method === 'GET' && !id) return json(listFormats());
		break;

	case 'users':
		if (method === 'POST' && !id) {
			const name = validateName((await readBody(request)).name);
			if (!name) throw new HttpError(400, `Names must be 1-18 characters and contain a letter or number.`);
			const userid = toID(name);
			const token = randomToken();
			if (!await createUser(env.DB, userid, name, await hashToken(token))) {
				throw new HttpError(409, `The name "${name}" is already registered.`);
			}
			return json({ userid, name, token }, 201);
		}
		break;

	case 'me':
		if (method === 'GET' && !id) return json(await requireUser(request, env));
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
				const user = await requireUser(request, env);
				const body = await readBody(request);
				const battleId = `${toID(body.format)}${randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 64);
				const players = unwrap(await battleStub(env, battleId).create({
					id: battleId,
					formatid: typeof body.format === 'string' ? body.format : '',
					rated: body.rated !== false,
					player: { userid: user.userid, name: user.name },
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
			const user = await requireUser(request, env);
			const body = await readBody(request);
			const players = unwrap(await battleStub(env, id).join({ userid: user.userid, name: user.name }, body.team));
			return json({ id, players });
		}
		if (action === 'ws' && method === 'GET') {
			if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, `Expected a WebSocket upgrade.`);
			// Spectators may connect anonymously; a valid token identifies players
			const user = await authenticate(request, env.DB);
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
