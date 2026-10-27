/**
 * Elo calculation, identical to `LadderStore#calculateElo` in
 * server/ladders-local.ts so ratings match a regular PS server.
 */
export function calculateElo(oldElo: number, score: number, foeElo: number): number {
	let K = 50;

	if (oldElo < 1200) {
		if (score < 0.5) {
			K = 10 + (oldElo - 1000) * 40 / 200;
		} else if (score > 0.5) {
			K = 90 - (oldElo - 1000) * 40 / 200;
		}
	} else if (oldElo > 1350 && oldElo <= 1600) {
		K = 40;
	} else {
		K = 32;
	}

	const E = 1 / (1 + 10 ** ((foeElo - oldElo) / 400));
	const newElo = oldElo + K * (score - E);
	return Math.max(newElo, 1000);
}
