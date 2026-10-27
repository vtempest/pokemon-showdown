import type { BattleRoom } from './battle-room';

export interface Env {
	/** D1 database holding users, battles and the ladder */
	DB: D1Database;
	/** One Durable Object instance per battle */
	BATTLES: DurableObjectNamespace<BattleRoom>;
}
