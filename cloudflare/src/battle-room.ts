/**
 * A battle room: one Durable Object per battle.
 *
 * The simulator is synchronous and deterministic given its input log, so the
 * room keeps only the input log in Durable Object storage. Whenever the
 * object is evicted (e.g. while every WebSocket is hibernating) the battle is
 * rebuilt on the next message by replaying that log.
 *
 * WebSocket protocol (one message per frame):
 *
 * - server -> client: standard Showdown battle protocol lines, already split
 *   per viewer (players see their own private `|split|` lines and their
 *   `|request|`s, spectators see the public ones)
 * - client -> server:
 *   - `/choose <choice>` (e.g. `/choose move 1`, `/choose switch 3`)
 *   - `/undo`
 *   - `/forfeit`
 *   - anything else is sent to the room as chat (logged-in users only)
 */

import { DurableObject } from 'cloudflare:workers';
import { Battle, extractChannelMessages } from '../../sim/battle';
import { PRNG, type PRNGSeed } from '../../sim/prng';
import type { Env } from './env';
import { finishBattle, insertBattle, startBattle, updateLadder, type RatingChange } from './db';
import { getFormat, prepareTeam, type Result } from './sim';

type Slot = 'p1' | 'p2';
const SLOTS: readonly Slot[] = ['p1', 'p2'];

interface PlayerInfo {
	userid: string;
	name: string;
	/** Packed team, or null for generated teams */
	team: string | null;
}

interface RoomState {
	id: string;
	formatid: string;
	rated: boolean;
	seed: PRNGSeed;
	/** If set, only this user may join as p2 */
	invited: string | null;
	players: Partial<Record<Slot, PlayerInfo>>;
	inputLog: string[];
	ended: boolean;
}

export interface Viewer {
	userid: string;
	name: string;
}

interface SocketAttachment {
	slot: Slot | null;
	userid: string | null;
	name: string | null;
}

const STATE_KEY = 'state';
const MAX_CHAT_LENGTH = 300;

export class BattleRoom extends DurableObject<Env> {
	private state: RoomState | null = null;
	private battle: Battle | null = null;
	/** Work (D1 writes) triggered by the simulator's synchronous callbacks */
	private pending: Promise<unknown>[] = [];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		void ctx.blockConcurrencyWhile(async () => {
			this.state = await ctx.storage.get<RoomState>(STATE_KEY) ?? null;
		});
	}

	// RPC methods, called by the Worker

	async create(options: {
		id: string, formatid: string, rated: boolean, player: Viewer, team: unknown, invited: string | null,
	}): Promise<Result<RoomState['players']>> {
		if (this.state) return { ok: false, error: `Battle ${options.id} already exists.` };
		const format = getFormat(options.formatid);
		if (!format.ok) return format;
		const team = prepareTeam(format.value, options.team);
		if (!team.ok) return team;

		this.state = {
			id: options.id,
			formatid: format.value.id,
			rated: options.rated && format.value.rated !== false,
			seed: PRNG.generateSeed(),
			invited: options.invited,
			players: { p1: { ...options.player, team: team.value } },
			inputLog: [],
			ended: false,
		};
		await this.save();
		await insertBattle(this.env.DB, {
			id: this.state.id, format: this.state.formatid, rated: this.state.rated, p1: options.player.userid,
		});
		return { ok: true, value: this.publicPlayers() };
	}

	async join(player: Viewer, team: unknown): Promise<Result<RoomState['players']>> {
		const state = this.state;
		if (!state) return { ok: false, error: `Battle not found.` };
		if (state.players.p2) return { ok: false, error: `This battle already has two players.` };
		if (state.players.p1!.userid === player.userid) return { ok: false, error: `You can't battle yourself.` };
		if (state.invited && state.invited !== player.userid) {
			return { ok: false, error: `This battle is reserved for another player.` };
		}
		const format = getFormat(state.formatid);
		if (!format.ok) return format;
		const prepared = prepareTeam(format.value, team);
		if (!prepared.ok) return prepared;

		state.players.p2 = { ...player, team: prepared.value };
		await startBattle(this.env.DB, state.id, player.userid);
		this.startBattle();
		await this.flush();
		return { ok: true, value: this.publicPlayers() };
	}

	/** The battle as seen by a spectator */
	info() {
		const state = this.state;
		if (!state) return null;
		const battle = this.getBattle();
		return {
			id: state.id,
			format: state.formatid,
			rated: state.rated,
			ended: state.ended,
			players: this.publicPlayers(),
			turn: battle?.turn ?? 0,
			log: battle ? this.channelLog(0) : '',
		};
	}

	// WebSockets (hibernation API)

	override fetch(request: Request): Response {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected a WebSocket upgrade', { status: 426 });
		}
		const state = this.state;
		if (!state) return new Response('Battle not found', { status: 404 });

		const userid = request.headers.get('X-PS-Userid');
		const name = request.headers.get('X-PS-Name');
		const slot = SLOTS.find(s => userid && state.players[s]?.userid === userid) ?? null;

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.ctx.acceptWebSocket(server, [slot ?? 'spectator']);
		server.serializeAttachment({ slot, userid, name } satisfies SocketAttachment);

		const battle = this.getBattle();
		const intro = [`|init|battle`, `|title|${this.title()}`];
		if (slot) intro.push(`|player|${slot}|${state.players[slot]!.name}`);
		server.send(intro.join('\n'));
		if (battle) {
			server.send(this.channelLog(slot ? channelOf(slot) : 0));
			const activeRequest = slot && !state.ended ? battle.getSide(slot).activeRequest : null;
			if (activeRequest) server.send(`|request|${JSON.stringify(activeRequest)}`);
		} else {
			server.send(`|message|Waiting for an opponent...`);
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (typeof message !== 'string') return;
		const { slot, name } = ws.deserializeAttachment() as SocketAttachment;
		const battle = this.getBattle();
		const text = message.trim();
		if (!text) return;

		const [command, rest] = text.startsWith('/') ? splitFirst(text.slice(1), ' ') : ['', text];
		if (['choose', 'undo', 'forfeit'].includes(command)) {
			if (!slot) return ws.send(`|error|You are not a player in this battle.`);
			if (!battle || this.state!.ended) return ws.send(`|error|The battle isn't running.`);
			// invalid choices are reported to the player by the simulator itself
			if (command === 'choose') {
				battle.choose(slot, rest);
			} else if (command === 'undo') {
				battle.undoChoice(slot);
			} else {
				forfeit(battle, slot);
			}
		} else if (command) {
			return ws.send(`|error|Unknown command /${command}.`);
		} else {
			if (!name) return ws.send(`|error|You must be logged in to chat.`);
			if (!battle) return;
			const chat = text.slice(0, MAX_CHAT_LENGTH).replace(/\n/g, ' ');
			battle.add('c', name, chat);
			battle.inputLog.push(`>chat-inputlogonly ${name}|${chat}`);
		}
		battle?.sendUpdates();
		await this.flush();
	}

	override webSocketClose(ws: WebSocket, code: number) {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, 'Closing');
		} catch {}
	}

	// Battle lifecycle

	private startBattle() {
		const state = this.state!;
		const battle = this.createBattle();
		for (const slot of SLOTS) {
			const player = state.players[slot]!;
			battle.setPlayer(slot, { name: player.name, team: player.team ?? undefined });
		}
		battle.sendUpdates();
	}

	/** Returns the running battle, rebuilding it from the input log after an eviction */
	private getBattle(): Battle | null {
		if (this.battle) return this.battle;
		const state = this.state;
		if (!state?.players.p2 || !state.inputLog.length) return null;

		// Replay silently, then reconnect the output
		let replaying = true;
		const [startLine, ...lines] = state.inputLog;
		const battle = this.createBattle(JSON.parse(startLine.slice('>start '.length)), () => replaying);
		for (const line of lines) {
			applyInputLine(battle, line);
			battle.sendUpdates();
		}
		replaying = false;
		return battle;
	}

	private createBattle(options?: { formatid: string, seed: PRNGSeed, rated?: string | true }, muted = () => false) {
		const state = this.state!;
		this.battle = new Battle({
			formatid: (options?.formatid ?? state.formatid) as ID,
			seed: options?.seed ?? state.seed,
			rated: options ? options.rated : state.rated || undefined,
			send: (type, data) => {
				if (muted()) return;
				this.onBattleOutput(type, Array.isArray(data) ? data.join('\n') : data);
			},
		});
		return this.battle;
	}

	private onBattleOutput(type: string, data: string) {
		switch (type) {
		case 'update': {
			const channels = extractChannelMessages(data, [0, 1, 2]);
			this.broadcast('spectator', channels[0].join('\n'));
			this.broadcast('p1', channels[1].join('\n'));
			this.broadcast('p2', channels[2].join('\n'));
			break;
		}
		case 'sideupdate': {
			const [slot, update] = splitFirst(data, '\n');
			this.broadcast(slot as Slot, update);
			break;
		}
		case 'end':
			this.pending.push(this.onBattleEnd(JSON.parse(data)));
			break;
		}
	}

	private async onBattleEnd(result: { winner: string, turns: number }) {
		const state = this.state!;
		state.ended = true;
		const p1 = state.players.p1!;
		const p2 = state.players.p2!;
		const winnerSlot = SLOTS.find(slot => state.players[slot]!.name === result.winner);
		const winner = winnerSlot ? state.players[winnerSlot]!.userid : '';

		await finishBattle(this.env.DB, state.id, {
			winner,
			turns: result.turns,
			log: this.channelLog(0),
			inputLog: this.battle!.inputLog.join('\n'),
		});
		if (!state.rated) return;

		const p1score = winnerSlot === 'p1' ? 1 : winnerSlot === 'p2' ? 0 : 0.5;
		const changes = await updateLadder(this.env.DB, state.formatid, p1.userid, p2.userid, p1score);
		const lines = changes.map((change, i) => ratingLine(i ? p2.name : p1.name, change));
		this.broadcastAll(lines.join('\n'));
	}

	// Helpers

	/** Persists the input log and waits for any D1 writes the battle triggered */
	private async flush() {
		if (this.battle) this.state!.inputLog = this.battle.inputLog.slice();
		const pending = this.pending;
		this.pending = [];
		await Promise.all(pending);
		await this.save();
	}

	private async save() {
		await this.ctx.storage.put(STATE_KEY, this.state);
	}

	private channelLog(channel: 0 | 1 | 2) {
		if (!this.battle) return '';
		return extractChannelMessages(this.battle.log.join('\n'), [channel])[channel].join('\n');
	}

	private broadcast(tag: Slot | 'spectator', message: string) {
		if (!message) return;
		for (const ws of this.ctx.getWebSockets(tag)) {
			try {
				ws.send(message);
			} catch {}
		}
	}

	private broadcastAll(message: string) {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {}
		}
	}

	private publicPlayers() {
		const players: RoomState['players'] = {};
		for (const slot of SLOTS) {
			const player = this.state?.players[slot];
			if (player) players[slot] = { userid: player.userid, name: player.name, team: null };
		}
		return players;
	}

	private title() {
		const { p1, p2 } = this.state!.players;
		return `${p1?.name ?? '?'} vs. ${p2?.name ?? '?'}`;
	}
}

function channelOf(slot: Slot) {
	return slot === 'p1' ? 1 : 2;
}

function splitFirst(str: string, delimiter: string): [string, string] {
	const index = str.indexOf(delimiter);
	if (index < 0) return [str, ''];
	return [str.slice(0, index), str.slice(index + delimiter.length)];
}

function ratingLine(name: string, change: RatingChange) {
	const oldElo = Math.round(change.oldElo);
	const newElo = Math.round(change.newElo);
	const diff = newElo - oldElo;
	return `|raw|${escapeHTML(name)}'s rating: ${oldElo} &rarr; <strong>${newElo}</strong><br />` +
		`(${diff >= 0 ? '+' : ''}${diff} for ${diff > 0 ? 'winning' : diff < 0 ? 'losing' : 'tying'})`;
}

function escapeHTML(str: string) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function forfeit(battle: Battle, slot: Slot) {
	battle.add('-message', `${battle.getSide(slot).name} forfeited.`);
	battle.lose(slot);
	battle.inputLog.push(`>forcelose ${slot}`);
}

/** Mirrors the input-log handling of `BattleStream#_writeLine` for the commands this room records */
function applyInputLine(battle: Battle, line: string) {
	const [type, message] = splitFirst(line.slice(1), ' ');
	switch (type) {
	case 'player': {
		const [slot, options] = splitFirst(message, ' ');
		battle.setPlayer(slot as Slot, JSON.parse(options));
		break;
	}
	case 'p1': case 'p2':
		if (message === 'undo') {
			battle.undoChoice(type);
		} else {
			battle.choose(type, message);
		}
		break;
	case 'forcelose':
		forfeit(battle, message as Slot);
		break;
	case 'chat-inputlogonly': {
		const [name, chat] = splitFirst(message, '|');
		battle.add('c', name, chat);
		battle.inputLog.push(line);
		break;
	}
	default:
		throw new Error(`Unexpected input log line: ${line}`);
	}
}
