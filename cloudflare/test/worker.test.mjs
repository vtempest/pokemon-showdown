/**
 * End-to-end test: runs the Worker under `wrangler dev` (local workerd,
 * Durable Objects and D1) and plays full Random Battles over WebSockets.
 *
 * Run with `npm test` from this directory (uses mocha, like the main test suite).
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(HERE, 'node_modules', '.bin', 'wrangler');
const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };

let persistDir;
let server;

async function api(method, pathname, { body, token } = {}) {
	// like a browser on the same origin; better-auth rejects auth POSTs without one (CSRF protection)
	const headers = { 'Content-Type': 'application/json', 'Origin': BASE };
	if (token) headers.Authorization = `Bearer ${token}`;
	const init = { method, headers, redirect: 'manual' };
	if (body) init.body = JSON.stringify(body);
	const res = await fetch(BASE + pathname, init);
	const text = await res.text();
	return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

/**
 * Signs up through better-auth (email/password, or a guest session) and
 * claims a Showdown name. Returns the bearer session token.
 */
async function account(name, { guest = false } = {}) {
	const signIn = guest ?
		await api('POST', '/api/auth/sign-in/anonymous', { body: {} }) :
		await api('POST', '/api/auth/sign-up/email', {
			body: { name, email: `${name.toLowerCase().replace(/\W/g, '')}@example.com`, password: 'correct horse battery staple' },
		});
	assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
	const token = signIn.headers.get('set-auth-token');
	assert(token, 'better-auth bearer plugin returns the session token');
	const claimed = await api('POST', '/api/users', { token, body: { name } });
	assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
	return { ...claimed.body, token };
}

function connect(battleId, token) {
	return new WebSocket(`ws://127.0.0.1:${PORT}/api/battles/${battleId}/ws` + (token ? `?token=${encodeURIComponent(token)}` : ''));
}

async function startServer() {
	server = spawn(WRANGLER, [
		'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', persistDir,
		'--show-interactive-dev-session=false',
		'--var', `BETTER_AUTH_URL:${BASE}`,
		'--var', 'BETTER_AUTH_SECRET:test-secret-test-secret-test-secret-0123',
		'--var', 'EMAIL_PASSWORD_LOGIN:true',
		'--var', 'GOOGLE_CLIENT_ID:test-client-id.apps.googleusercontent.com',
		'--var', 'GOOGLE_CLIENT_SECRET:test-client-secret',
	], { cwd: HERE, env, stdio: 'ignore' });
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(BASE)).ok) return;
		} catch {}
		await new Promise(resolve => {
			setTimeout(resolve, 500);
		});
	}
	throw new Error(`wrangler dev did not start`);
}

async function stopServer() {
	if (!server || server.exitCode !== null) return;
	const exited = new Promise(resolve => {
		server.once('exit', resolve);
	});
	server.kill('SIGINT');
	await exited;
}

/**
 * Connects to a battle and answers every request with `/choose default`.
 * `done` resolves when the battle ends, or once `untilTurn` starts.
 */
function autoPlayer(battleId, token, untilTurn = Infinity) {
	const ws = connect(battleId, token);
	const messages = [];
	const done = new Promise((resolve, reject) => {
		ws.addEventListener('message', ({ data }) => {
			messages.push(data);
			for (const line of data.split('\n')) {
				if (line.startsWith('|request|') && !messages.join('\n').includes(`|turn|${untilTurn}`)) {
					const request = JSON.parse(line.slice('|request|'.length));
					if (!request.wait) ws.send(`/choose default`);
				}
				// rating updates arrive right after the result
				if (line.startsWith('|win|') || line === '|tie') setTimeout(resolve, 500);
				if (line === `|turn|${untilTurn}`) resolve();
			}
		});
		ws.addEventListener('error', reject);
	});
	const opened = new Promise(resolve => {
		ws.addEventListener('open', resolve);
	});
	return { ws, messages, done, opened };
}

describe('Cloudflare Worker', function () {
	this.timeout(180_000);

	before(async () => {
		persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-cf-'));
		const migrate = spawnSync(WRANGLER, [
			'd1', 'migrations', 'apply', 'pokemon-showdown', '--local', '--persist-to', persistDir,
		], { cwd: HERE, env, encoding: 'utf8' });
		assert.equal(migrate.status, 0, migrate.stderr + migrate.stdout);

		await startServer();
	});

	after(async () => {
		await stopServer();
		if (persistDir) fs.rmSync(persistDir, { recursive: true, force: true });
	});

	it('lists formats', async () => {
		const { status, body } = await api('GET', '/api/formats');
		assert.equal(status, 200);
		assert(body.some(format => format.id === 'gen9randombattle'));
		assert(body.some(format => format.id === 'gen9ou'));
	});

	it('validates and generates teams', async () => {
		const generated = await api('POST', '/api/teams/generate', { body: { format: 'gen9randombattle' } });
		assert.equal(generated.status, 200, JSON.stringify(generated.body));
		assert.match(generated.body.team, /Ability: /);

		const valid = await api('POST', '/api/teams/validate', {
			body: {
				format: 'gen9ou',
				team: `Garchomp @ Rocky Helmet\nAbility: Rough Skin\nTera Type: Steel\nEVs: 252 HP / 4 Def / 252 Spe\n` +
					`Jolly Nature\n- Earthquake\n- Stealth Rock\n- Spikes\n- Dragon Tail`,
			},
		});
		assert.equal(valid.body.valid, true, valid.body.error);

		const invalid = await api('POST', '/api/teams/validate', {
			body: { format: 'gen9ou', team: `Mewtwo\nAbility: Pressure\n- Psystrike` },
		});
		assert.equal(invalid.body.valid, false);
		assert.match(invalid.body.error, /Mewtwo/);
	});

	it('serves the web client and auth config', async () => {
		const page = await fetch(BASE + '/');
		assert.equal(page.status, 200);
		assert.match(await page.text(), /Sign in with Google/);
		const config = await api('GET', '/api/config');
		assert.deepEqual(config.body.providers, { google: true, guest: true, emailPassword: true });
	});

	it('starts the Google OAuth flow', async () => {
		const res = await api('POST', '/api/auth/sign-in/social', { body: { provider: 'google', callbackURL: `${BASE}/` } });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		const url = new URL(res.body.url);
		assert.equal(url.origin, 'https://accounts.google.com');
		assert.equal(url.searchParams.get('client_id'), 'test-client-id.apps.googleusercontent.com');
		assert.equal(url.searchParams.get('redirect_uri'), `${BASE}/api/auth/callback/google`);
	});

	it('claims names for signed-in accounts', async () => {
		assert.equal((await api('POST', '/api/users', { body: { name: 'Nobody' } })).status, 401);

		const taken = await account('Taken Name');
		assert.equal(taken.userid, 'takenname');
		const me = (await api('GET', '/api/me', { token: taken.token })).body;
		assert.equal(me.name, 'Taken Name');
		assert.equal(me.email, 'takenname@example.com');
		assert.equal(me.guest, false);
		// one name per account
		assert.equal((await api('POST', '/api/users', { token: taken.token, body: { name: 'Other' } })).status, 409);

		const guest = (await api('POST', '/api/auth/sign-in/anonymous', { body: {} })).headers.get('set-auth-token');
		assert.equal((await api('GET', '/api/me', { token: guest })).body.hasName, false);
		// battling needs a name
		assert.equal((await api('POST', '/api/battles', { token: guest, body: { format: 'gen9randombattle' } })).status, 403);
		assert.equal((await api('POST', '/api/users', { token: guest, body: { name: 'takenname' } })).status, 409);
		assert.equal((await api('GET', '/api/me', { token: 'nope' })).status, 401);
	});

	it('keeps guests out of rated battles', async () => {
		const host = await account('Rated Host');
		const visitor = await account('Visitor', { guest: true });
		const rated = (await api('POST', '/api/battles', { token: host.token, body: { format: 'gen9randombattle' } })).body;
		const join = await api('POST', `/api/battles/${rated.id}/join`, { token: visitor.token, body: {} });
		assert.equal(join.status, 400);
		assert.match(join.body.error, /Rated battles need/);

		const created = await api('POST', '/api/battles', { token: visitor.token, body: { format: 'gen9randombattle' } });
		assert.equal(created.status, 201);
		assert.equal((await api('GET', `/api/battles/${created.body.id}`)).body.rated, false);
	});

	it('plays a rated battle to completion and updates the ladder', async () => {
		const alice = await account('Alice');
		const bob = await account('Bob');
		const carol = await account('Carol');

		const created = await api('POST', '/api/battles', {
			token: alice.token, body: { format: 'gen9randombattle', opponent: 'Bob' },
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		const battleId = created.body.id;

		const p1 = autoPlayer(battleId, alice.token);
		const spectator = autoPlayer(battleId);
		await Promise.all([p1.opened, spectator.opened]);

		// reserved for Bob
		assert.equal((await api('POST', `/api/battles/${battleId}/join`, { token: carol.token, body: {} })).status, 400);
		const joined = await api('POST', `/api/battles/${battleId}/join`, { token: bob.token, body: {} });
		assert.equal(joined.status, 200, JSON.stringify(joined.body));
		const p2 = autoPlayer(battleId, bob.token);

		await Promise.all([p1.done, p2.done, spectator.done]);
		for (const player of [p1, p2, spectator]) player.ws.close();

		const p1log = p1.messages.join('\n');
		const spectatorLog = spectator.messages.join('\n');
		assert.match(p1log, /\|request\|/);
		assert.doesNotMatch(spectatorLog, /\|request\|/);
		assert.match(spectatorLog, /\|win\|(Alice|Bob)/);
		assert.match(spectatorLog, /rating: 1000 &rarr;/);

		const battle = (await api('GET', `/api/battles/${battleId}`)).body;
		assert.equal(battle.status, 'ended');
		assert(['alice', 'bob'].includes(battle.winner));
		assert.match(battle.log, /\|turn\|1/);
		assert.match(battle.input_log, /^>start /);

		const ladder = (await api('GET', '/api/ladder/gen9randombattle')).body;
		assert.equal(ladder.length, 2);
		assert.equal(ladder[0].userid, battle.winner);
		assert(ladder[0].elo > 1000);
		assert.equal(ladder[0].w, 1);
		assert.equal(ladder[1].l, 1);

		const listed = (await api('GET', `/api/battles?user=alice`)).body;
		assert.equal(listed[0].id, battleId);
	});

	it('lets a player forfeit, without touching the ladder in unrated battles', async () => {
		const dave = await account('Dave');
		const erin = await account('Erin');
		const { id } = (await api('POST', '/api/battles', {
			token: dave.token, body: { format: 'gen9randombattle', rated: false },
		})).body;
		await api('POST', `/api/battles/${id}/join`, { token: erin.token, body: {} });

		const ws = connect(id, dave.token);
		const won = new Promise(resolve => {
			ws.addEventListener('message', ({ data }) => {
				if (data.includes('|win|Erin')) resolve();
			});
		});
		ws.addEventListener('open', () => ws.send('/forfeit'));
		await won;
		ws.close();

		const battle = (await api('GET', `/api/battles/${id}`)).body;
		assert.equal(battle.winner, 'erin');
		assert.equal(battle.rated, 0);
		assert.equal((await api('GET', '/api/ladder/gen9randombattle')).body.length, 2);
	});

	it('rejects choices from spectators', async () => {
		const frank = await account('Frank');
		const { id } = (await api('POST', '/api/battles', {
			token: frank.token, body: { format: 'gen9randombattle' },
		})).body;
		const ws = connect(id);
		const error = new Promise(resolve => {
			ws.addEventListener('message', ({ data }) => {
				if (data.startsWith('|error|')) resolve(data);
			});
		});
		ws.addEventListener('open', () => ws.send('/choose move 1'));
		assert.match(await error, /not a player/);
		ws.close();
	});

	it('resumes a battle from its input log after a restart', async () => {
		const gina = await account('Gina');
		const hank = await account('Hank');
		const { id } = (await api('POST', '/api/battles', {
			token: gina.token, body: { format: 'gen9randombattle', rated: false },
		})).body;
		await api('POST', `/api/battles/${id}/join`, { token: hank.token, body: {} });

		const before = [autoPlayer(id, gina.token, 3), autoPlayer(id, hank.token, 3)];
		await Promise.all(before.map(player => player.done));
		for (const player of before) player.ws.close();
		const { log: logBefore } = (await api('GET', `/api/battles/${id}`)).body;
		assert.match(logBefore, /\|turn\|3/);

		// Restarting wrangler dev discards every Durable Object from memory
		await stopServer();
		await startServer();

		// Replaying is deterministic; only the `|t:|` timestamps are regenerated
		const { log: logAfter } = (await api('GET', `/api/battles/${id}`)).body;
		const withoutTimestamps = log => log.replace(/^\|t:\|\d+$/gm, '|t:|');
		assert.equal(withoutTimestamps(logAfter), withoutTimestamps(logBefore));

		const after = [autoPlayer(id, gina.token), autoPlayer(id, hank.token)];
		await Promise.all(after.map(player => player.done));
		for (const player of after) player.ws.close();

		const battle = (await api('GET', `/api/battles/${id}`)).body;
		assert.equal(battle.status, 'ended');
		assert(['gina', 'hank'].includes(battle.winner));
		assert.equal(battle.log.split('|turn|1\n').length, 2);
	});
});
