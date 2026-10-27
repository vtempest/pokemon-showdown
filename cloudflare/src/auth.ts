/**
 * Minimal token auth: registering a name returns a random bearer token,
 * and only its SHA-256 hash is stored in D1.
 */

import { toID } from '../../sim/dex';
import { getUserByTokenHash, type UserRow } from './db';

export function randomToken(bytes = 24): string {
	const buf = crypto.getRandomValues(new Uint8Array(bytes));
	let binary = '';
	for (const byte of buf) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Reads the token from `Authorization: Bearer ...`, or `?token=` (browsers can't set WebSocket headers) */
export function requestToken(request: Request): string | null {
	const header = request.headers.get('Authorization');
	if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
	return new URL(request.url).searchParams.get('token');
}

export async function authenticate(request: Request, db: D1Database): Promise<UserRow | null> {
	const token = requestToken(request);
	if (!token) return null;
	return getUserByTokenHash(db, await hashToken(token));
}

/** Same rules as the main server: 1-18 characters, at least one alphanumeric */
export function validateName(input: unknown): string | null {
	if (typeof input !== 'string') return null;
	const name = input.replace(/[|,;\s]+/g, ' ').trim();
	if (!name.length || name.length > 18 || !toID(name)) return null;
	return name;
}
