/**
 * Bundles the Pokémon Showdown simulator into a single Cloudflare Worker.
 *
 * The simulator expects a Node.js filesystem: the Dex discovers mods with
 * `fs.readdirSync` and loads data with `require(computedPath)`. Workers have
 * no filesystem, so at build time we:
 *
 * - replace `__dirname` with a virtual path (`/ps/<dir>`)
 * - rewrite the dynamic `require`s in the Dex loaders to a registry that
 *   statically bundles every data file they could ask for (each module is
 *   only evaluated the first time it is required)
 * - provide a tiny `fs` shim whose `readdirSync` lists the bundled mods
 *
 * Usage: node build.mjs [--minify=false]
 */

import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const VIRTUAL_ROOT = '/ps';
const OUTDIR = path.join(HERE, 'dist');

/** Data files the Dex loads via `require(DATA_DIR + name)` */
const DATA_FILES = [
	'abilities', 'rulesets', 'formats-data', 'items', 'learnsets', 'moves',
	'natures', 'pokedex', 'pokemongo', 'scripts', 'conditions', 'typechart',
];
/** Files whose dynamic `require`s must go through the registry */
const DYNAMIC_REQUIRE_FILES = ['sim/dex.ts', 'sim/dex-text.ts', 'sim/dex-formats.ts', 'sim/teams.ts'];
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js'];

const toPosix = p => p.split(path.sep).join('/');
const virtualPath = file => `${VIRTUAL_ROOT}/${toPosix(path.relative(ROOT, file))}`;

function findModule(fileWithoutExt) {
	for (const ext of SOURCE_EXTENSIONS) {
		if (fs.existsSync(fileWithoutExt + ext)) return fileWithoutExt + ext;
	}
	return null;
}

function collectRegistryEntries() {
	const entries = [];
	const add = fileWithoutExt => {
		const file = findModule(fileWithoutExt);
		if (file) entries.push([virtualPath(fileWithoutExt), file]);
	};

	const dataDir = path.join(ROOT, 'data');
	for (const name of DATA_FILES) add(path.join(dataDir, name));
	add(path.join(dataDir, 'aliases'));

	const modsDir = path.join(dataDir, 'mods');
	const mods = fs.readdirSync(modsDir, { withFileTypes: true })
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
	for (const mod of mods) {
		for (const name of DATA_FILES) add(path.join(modsDir, mod, name));
	}

	// English text only; other languages are loaded on demand by
	// `Dex.loadTextData(lang)` and would roughly double the bundle size.
	const textDir = path.join(dataDir, 'text');
	for (const entry of fs.readdirSync(textDir, { withFileTypes: true })) {
		if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
			add(path.join(textDir, path.basename(entry.name, path.extname(entry.name))));
		}
	}

	// Random team generators, loaded by `Teams.getGenerator`
	const randomBattlesDir = path.join(dataDir, 'random-battles');
	for (const entry of fs.readdirSync(randomBattlesDir, { withFileTypes: true })) {
		if (entry.isDirectory()) add(path.join(randomBattlesDir, entry.name, 'teams'));
	}
	for (const mod of mods) add(path.join(modsDir, mod, 'random-teams'));

	add(path.join(ROOT, 'config', 'formats'));
	add(path.join(ROOT, 'config', 'custom-formats'));

	return { entries, directories: { [virtualPath(modsDir)]: mods } };
}

function registryModuleSource() {
	const { entries, directories } = collectRegistryEntries();
	const loaders = entries.map(
		([key, file]) => `\t${JSON.stringify(key)}: () => require(${JSON.stringify(file)}),`
	);
	return [
		`const loaders = {\n${loaders.join('\n')}\n};`,
		`export const directories = ${JSON.stringify(directories)};`,
		`const cache = Object.create(null);`,
		`function normalize(p) {`,
		`\tconst out = [];`,
		`\tfor (const part of p.split('/')) {`,
		`\t\tif (!part || part === '.') continue;`,
		`\t\tif (part === '..') out.pop(); else out.push(part);`,
		`\t}`,
		`\treturn ('/' + out.join('/')).replace(/\\.(ts|tsx|js)$/, '');`,
		`}`,
		`function notFound(p) {`,
		`\tconst err = new Error("Cannot find module '" + p + "'");`,
		`\terr.code = 'MODULE_NOT_FOUND';`,
		`\treturn err;`,
		`}`,
		`export function psRequireFrom(base) {`,
		`\tconst req = p => psRequire(p.startsWith('/') ? p : base + '/' + p);`,
		`\treq.resolve = p => psRequire.resolve(p.startsWith('/') ? p : base + '/' + p);`,
		`\treturn req;`,
		`}`,
		`export function psRequire(p) {`,
		`\tconst key = normalize(p);`,
		`\tif (key in cache) return cache[key];`,
		`\tconst load = loaders[key];`,
		`\tif (!load) throw notFound(p);`,
		`\treturn (cache[key] = load());`,
		`}`,
		`psRequire.resolve = p => {`,
		`\tconst key = normalize(p);`,
		`\tif (!loaders[key]) throw notFound(p);`,
		`\treturn key;`,
		`};`,
	].join('\n');
}

const FS_SHIM = `
import { directories } from 'ps-registry';
function enoent(p) {
	const err = new Error("ENOENT: no such file or directory, scandir '" + p + "'");
	err.code = 'ENOENT';
	return err;
}
export function readdirSync(p) {
	const list = directories[p.replace(/\\/+$/, '')];
	if (!list) throw enoent(p);
	return list.slice();
}
export function existsSync(p) {
	return p.replace(/\\/+$/, '') in directories;
}
export default { readdirSync, existsSync };
`;

/**
 * Worker-safe replacement for lib/index.ts, which also re-exports Node-only
 * modules (net, child processes, SQL). Data files only need Utils/Streams,
 * and gen9ssb reads optional config files through FS at load time.
 */
const LIB_SHIM = `
export * as Utils from './lib/utils';
export * as Streams from './lib/streams';
export * as Dashycode from './lib/dashycode';
function unsupported(path, method) {
	throw new Error('FS(' + JSON.stringify(path) + ').' + method + '() is not available on Cloudflare Workers');
}
export function FS(path) {
	return new Proxy({}, {
		get(_, method) {
			if (method === 'readIfExistsSync') return () => '';
			if (method === 'readIfExists') return async () => '';
			if (method === 'existsSync') return () => false;
			if (method === 'exists') return async () => false;
			return () => unsupported(path, String(method));
		},
	});
}
`;

/** @type {esbuild.Plugin} */
const showdownPlugin = {
	name: 'showdown-workers',
	setup(build) {
		build.onResolve({ filter: /^ps-registry$/ }, () => ({ path: 'ps-registry', namespace: 'ps-virtual' }));
		build.onResolve({ filter: /^(node:)?fs$/ }, () => ({ path: 'fs', namespace: 'ps-virtual' }));
		build.onResolve({ filter: /^(\.\.\/)+lib(\/index)?$/ }, args => {
			const target = path.resolve(args.resolveDir, args.path);
			if (target !== path.join(ROOT, 'lib') && target !== path.join(ROOT, 'lib', 'index')) return;
			return { path: 'lib', namespace: 'ps-virtual' };
		});
		build.onLoad({ filter: /.*/, namespace: 'ps-virtual' }, args => ({
			contents: { fs: FS_SHIM, lib: LIB_SHIM }[args.path] ?? registryModuleSource(),
			loader: 'js',
			resolveDir: ROOT,
		}));

		// Rewrite `__dirname` (and dynamic `require`s in the Dex loaders) in
		// the main codebase.
		build.onLoad({ filter: /\.(ts|tsx|js)$/ }, async args => {
			const rel = toPosix(path.relative(ROOT, args.path));
			if (rel.startsWith('..') || rel.includes('node_modules/') || rel.startsWith('cloudflare/')) return;
			let contents = await fs.promises.readFile(args.path, 'utf8');
			const loader = path.extname(args.path).slice(1);
			const isDynamic = DYNAMIC_REQUIRE_FILES.includes(rel);
			if (!isDynamic && !contents.includes('__dirname')) return { contents, loader };

			const dir = JSON.stringify(`${VIRTUAL_ROOT}/${path.posix.dirname(rel)}`);
			contents = contents.replace(/\b__dirname\b/g, dir);
			if (isDynamic) {
				contents = contents.replace(/\brequire(\.resolve)?\(/g, (_, resolve) => `__psRequire${resolve || ''}(`);
				contents = `import { psRequireFrom } from 'ps-registry';\nconst __psRequire = psRequireFrom(${dir});\n${contents}`;
			}
			return { contents, loader };
		});
	},
};

export async function build({ minify = true } = {}) {
	fs.rmSync(OUTDIR, { recursive: true, force: true });
	const result = await esbuild.build({
		entryPoints: [path.join(HERE, 'src', 'worker.ts')],
		outfile: path.join(OUTDIR, 'worker.js'),
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		mainFields: ['module', 'main'],
		conditions: ['workerd', 'worker', 'import'],
		external: ['node:*', 'cloudflare:*'],
		alias: { path: 'node:path', crypto: 'node:crypto' },
		tsconfig: path.join(HERE, 'tsconfig.json'),
		loader: { '.html': 'text' },
		minify,
		keepNames: true,
		sourcemap: 'external',
		metafile: true,
		logLevel: 'warning',
		plugins: [showdownPlugin],
	});
	fs.writeFileSync(path.join(OUTDIR, 'meta.json'), JSON.stringify(result.metafile));
	const size = fs.statSync(path.join(OUTDIR, 'worker.js')).size;
	console.log(`Built cloudflare/dist/worker.js (${(size / 1024 / 1024).toFixed(2)} MiB)`);
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const minify = !process.argv.includes('--minify=false');
	build({ minify }).catch(err => {
		console.error(err);
		process.exit(1);
	});
}
