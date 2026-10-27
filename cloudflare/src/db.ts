/**
 * D1 queries. Everything persistent lives here: registered users, the
 * battle index (plus replays of finished battles) and the ladder.
 */

import { calculateElo } from './elo';

export interface UserRow {
	userid: string;
	name: string;
	created_at: number;
}

export interface BattleRow {
	id: string;
	format: string;
	rated: number;
	status: 'waiting' | 'active' | 'ended';
	p1: string;
	p2: string | null;
	winner: string | null;
	turns: number | null;
	log: string | null;
	input_log: string | null;
	created_at: number;
	ended_at: number | null;
}

export interface LadderRow {
	userid: string;
	format: string;
	elo: number;
	w: number;
	l: number;
	t: number;
	updated_at: number;
}

export interface RatingChange {
	userid: string;
	oldElo: number;
	newElo: number;
}

/** Returns false if the userid is taken, or the account already has a name */
export async function createUser(db: D1Database, userid: string, name: string, authUserId: string) {
	const result = await db.prepare(
		`INSERT INTO users (userid, name, auth_user_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`
	).bind(userid, name, authUserId, Date.now()).run();
	return result.meta.changes > 0;
}

export function getUserByAuthId(db: D1Database, authUserId: string) {
	return db.prepare(`SELECT userid, name, created_at FROM users WHERE auth_user_id = ?`)
		.bind(authUserId).first<UserRow>();
}

export async function insertBattle(
	db: D1Database, battle: { id: string, format: string, rated: boolean, p1: string }
) {
	await db.prepare(
		`INSERT INTO battles (id, format, rated, status, p1, created_at) VALUES (?, ?, ?, 'waiting', ?, ?)`
	).bind(battle.id, battle.format, battle.rated ? 1 : 0, battle.p1, Date.now()).run();
}

export async function startBattle(db: D1Database, id: string, p2: string) {
	await db.prepare(`UPDATE battles SET status = 'active', p2 = ? WHERE id = ?`).bind(p2, id).run();
}

export async function finishBattle(
	db: D1Database, id: string, result: { winner: string, turns: number, log: string, inputLog: string }
) {
	await db.prepare(
		`UPDATE battles SET status = 'ended', winner = ?, turns = ?, log = ?, input_log = ?, ended_at = ? WHERE id = ?`
	).bind(result.winner, result.turns, result.log, result.inputLog, Date.now(), id).run();
}

export function getBattle(db: D1Database, id: string) {
	return db.prepare(`SELECT * FROM battles WHERE id = ?`).bind(id).first<BattleRow>();
}

export async function listBattles(
	db: D1Database, filter: { status?: string, format?: string, userid?: string, limit: number }
) {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (filter.status) {
		where.push(`status = ?`);
		params.push(filter.status);
	}
	if (filter.format) {
		where.push(`format = ?`);
		params.push(filter.format);
	}
	if (filter.userid) {
		where.push(`(p1 = ? OR p2 = ?)`);
		params.push(filter.userid, filter.userid);
	}
	const query = `SELECT id, format, rated, status, p1, p2, winner, turns, created_at, ended_at FROM battles` +
		(where.length ? ` WHERE ${where.join(' AND ')}` : '') +
		` ORDER BY created_at DESC LIMIT ?`;
	const { results } = await db.prepare(query).bind(...params, filter.limit).all<Omit<BattleRow, 'log' | 'input_log'>>();
	return results;
}

export async function getLadder(db: D1Database, format: string, limit: number) {
	const { results } = await db.prepare(
		`SELECT l.userid, u.name, l.elo, l.w, l.l, l.t, l.updated_at FROM ladder l ` +
		`LEFT JOIN users u ON u.userid = l.userid WHERE l.format = ? ORDER BY l.elo DESC LIMIT ?`
	).bind(format, limit).all<LadderRow & { name: string | null }>();
	return results;
}

/**
 * Applies the result of a rated battle to both players' ladder rows.
 * `p1score` is 1 for a p1 win, 0 for a p2 win and 0.5 for a tie.
 */
export async function updateLadder(
	db: D1Database, format: string, p1: string, p2: string, p1score: number
): Promise<[RatingChange, RatingChange]> {
	const { results } = await db.prepare(
		`SELECT userid, elo FROM ladder WHERE format = ? AND userid IN (?, ?)`
	).bind(format, p1, p2).all<{ userid: string, elo: number }>();
	const oldElo = (userid: string) => results.find(row => row.userid === userid)?.elo ?? 1000;
	const p1old = oldElo(p1);
	const p2old = oldElo(p2);
	const changes: [RatingChange, RatingChange] = [
		{ userid: p1, oldElo: p1old, newElo: calculateElo(p1old, p1score, p2old) },
		{ userid: p2, oldElo: p2old, newElo: calculateElo(p2old, 1 - p1score, p1old) },
	];

	const now = Date.now();
	const upsert = db.prepare(
		`INSERT INTO ladder (userid, format, elo, w, l, t, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ` +
		`ON CONFLICT (userid, format) DO UPDATE SET elo = ?3, w = w + ?4, l = l + ?5, t = t + ?6, updated_at = ?7`
	);
	await db.batch(changes.map(({ userid, newElo }, i) => {
		const score = i === 0 ? p1score : 1 - p1score;
		const [w, l] = [score > 0.6 ? 1 : 0, score < 0.4 ? 1 : 0];
		return upsert.bind(userid, format, newElo, w, l, w || l ? 0 : 1, now);
	}));
	return changes;
}
