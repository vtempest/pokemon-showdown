import type { BattleRoom } from './battle-room';

export interface Env {
	/** D1 database holding accounts (better-auth), users, battles and the ladder */
	DB: D1Database;
	/** One Durable Object instance per battle */
	BATTLES: DurableObjectNamespace<BattleRoom>;

	/** Secret used by better-auth to sign sessions (`wrangler secret put BETTER_AUTH_SECRET`) */
	BETTER_AUTH_SECRET?: string;
	/** Public URL of the Worker, e.g. https://pokemon-showdown.example.workers.dev */
	BETTER_AUTH_URL?: string;
	/** Extra comma-separated origins allowed to use the auth API (e.g. a separately hosted client) */
	TRUSTED_ORIGINS?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** "true" enables email/password accounts (for local development and tests) */
	EMAIL_PASSWORD_LOGIN?: string;
}
