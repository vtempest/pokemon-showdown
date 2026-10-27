-- Pokémon Showdown on Cloudflare D1: initial schema

CREATE TABLE users (
	userid TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);

CREATE TABLE battles (
	id TEXT PRIMARY KEY,
	format TEXT NOT NULL,
	rated INTEGER NOT NULL DEFAULT 0,
	-- 'waiting' (for p2), 'active' or 'ended'
	status TEXT NOT NULL,
	p1 TEXT NOT NULL,
	p2 TEXT,
	-- userid of the winner, '' for a tie, NULL while unfinished
	winner TEXT,
	turns INTEGER,
	-- spectator view of the battle log, i.e. a replay
	log TEXT,
	input_log TEXT,
	created_at INTEGER NOT NULL,
	ended_at INTEGER
);
CREATE INDEX battles_status_created ON battles (status, created_at DESC);
CREATE INDEX battles_format_created ON battles (format, created_at DESC);
CREATE INDEX battles_p1 ON battles (p1, created_at DESC);
CREATE INDEX battles_p2 ON battles (p2, created_at DESC);

CREATE TABLE ladder (
	userid TEXT NOT NULL,
	format TEXT NOT NULL,
	elo REAL NOT NULL DEFAULT 1000,
	w INTEGER NOT NULL DEFAULT 0,
	l INTEGER NOT NULL DEFAULT 0,
	t INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (userid, format)
);
CREATE INDEX ladder_format_elo ON ladder (format, elo DESC);
