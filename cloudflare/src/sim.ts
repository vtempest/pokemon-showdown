/**
 * Thin helpers over the simulator for formats and teams.
 */

import { Dex, toID } from '../../sim/dex';
import type { Format } from '../../sim/dex-formats';
import { Teams } from '../../sim/teams';
import { TeamValidator } from '../../sim/team-validator';

export type Result<T> = { ok: true, value: T } | { ok: false, error: string };

/** Two-player formats only: multi and free-for-all battles need four sides */
export function getFormat(formatid: unknown): Result<Format> {
	if (typeof formatid !== 'string' || !toID(formatid)) return { ok: false, error: `A format is required.` };
	const format = Dex.formats.get(formatid);
	if (!format.exists || format.effectType !== 'Format') {
		return { ok: false, error: `Unknown format "${formatid}".` };
	}
	if (format.gameType === 'multi' || format.gameType === 'freeforall') {
		return { ok: false, error: `${format.name} needs four players, which this server doesn't support yet.` };
	}
	return { ok: true, value: format };
}

/**
 * Validates a team (packed, JSON or exported text) for a format and returns it
 * packed, or `null` for formats that generate teams (Random Battles).
 */
export function prepareTeam(format: Format, team: unknown): Result<string | null> {
	if (format.team) return { ok: true, value: null };
	if (typeof team !== 'string' || !team.trim()) {
		return { ok: false, error: `${format.name} requires a team.` };
	}
	const sets = Teams.import(team);
	if (!sets?.length) return { ok: false, error: `Your team could not be parsed.` };
	const problems = TeamValidator.get(format.id).validateTeam(sets);
	if (problems?.length) return { ok: false, error: problems.join('\n') };
	return { ok: true, value: Teams.pack(sets) };
}

export function validateTeam(formatid: unknown, team: unknown) {
	const format = getFormat(formatid);
	if (!format.ok) return format;
	return prepareTeam(format.value, team);
}

export function generateTeam(formatid: unknown, seed?: string): Result<string> {
	const format = getFormat(formatid);
	if (!format.ok) return format;
	if (!format.value.team) return { ok: false, error: `${format.value.name} doesn't generate teams.` };
	return { ok: true, value: Teams.export(Teams.generate(format.value.id, seed ? { seed: seed as any } : undefined)) };
}

export function listFormats() {
	return Dex.formats.all()
		.filter(format => format.effectType === 'Format' &&
			format.gameType !== 'multi' && format.gameType !== 'freeforall')
		.map(format => ({
			id: format.id,
			name: format.name,
			section: format.section,
			gameType: format.gameType,
			mod: format.mod,
			team: format.team || null,
			rated: format.rated !== false,
		}));
}
