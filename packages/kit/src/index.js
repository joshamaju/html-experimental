import path from 'node:path';
import esbuild from 'esbuild';
import fs from 'node:fs';
import url from 'node:url';
import fs_extra from 'fs-extra';
import colors from 'kleur';
import { load_config } from './core/config/index.js';
import { get_config_aliases, get_env } from './exports/vite/utils.js';
import { hash } from './runtime/hash.js';
import {
	copy,
	join_relative,
	mkdirp,
	posixify,
	relative_path,
	resolve_entry,
	rimraf
} from './utils/filesystem.js';
import { logger, runtime_directory } from './core/utils.js';
import { s } from './utils/misc.js';
import * as sync from './core/sync/sync.js';
import { dedent } from './core/sync/utils.js';
import { generate_manifest } from './core/generate_manifest/index.js';
import { build_server_nodes } from './exports/vite/build/build_server.js';
import { write_client_manifest } from './core/sync/write_client_manifest.js';
import analyse from './core/postbuild/analyse.js';
import prerender from './core/postbuild/prerender.js';
import { create_dynamic_module, create_static_module } from './core/env.js';
import create_manifest_data, { create_assets } from './core/sync/create_manifest_data/index.js';

import { Parcel } from '@parcel/core';
import { build_service_worker } from './exports/vite/build/build_service_worker.js';
import { init } from './core/sync/sync.js';
import { write_server } from './core/sync/write_server.js';
import { write_all_types } from './core/sync/write_types/index.js';
import { write_root } from './core/sync/write_root.js';

/**
 * @param {import('types').ValidatedConfig} config
 */
const create_service_worker_module = (config) => dedent`
	if (typeof self === 'undefined' || self instanceof ServiceWorkerGlobalScope === false) {
		throw new Error('This module can only be imported inside a service worker');
	}

	export const build = [];
	export const files = [
		${create_assets(config)
			.filter((asset) => config.kit.serviceWorker.files(asset.file))
			.map((asset) => `${s(`${config.kit.paths.base}/${asset.file}`)}`)
			.join(',\n')}
	];
	export const prerendered = [];
	export const version = ${s(config.kit.version.name)};
`;

const cwd = process.cwd();

const svelte_config = await load_config();

const { kit } = svelte_config;
const out = `${kit.outDir}/output`;


let mode = /** @type {'development' | 'production'} */ (process.env.NODE_ENV ?? 'development');

const options_regex = /(export\s+const\s+(prerender|csr|ssr|trailingSlash))\s*=/s;

rimraf(kit.outDir);
mkdirp(kit.outDir);

/** @type {{ public: Record<string, string>; private: Record<string, string> }} */
let env = get_env(kit.env, mode);

// /** @type {import('types').ManifestData} */
// let manifest_data;

const service_worker_entry_file = resolve_entry(kit.files.serviceWorker);

const generated = path.posix.join(kit.outDir, 'generated');

init(svelte_config, mode);

const manifest_data = create_manifest_data({ config: svelte_config });

const output = path.join(kit.outDir, 'generated');

write_server(svelte_config, output);

write_root(manifest_data, output);

await write_all_types(svelte_config, manifest_data);

// manifest_data = (await sync.all(svelte_config, mode)).manifest_data;

/** @type {Record<string, string>} */
const input = {};

input.index = `${runtime_directory}/server/index.js`;
input.internal = `${kit.outDir}/generated/server/internal.js`;

manifest_data.routes.forEach((route) => {
	if (route.endpoint) {
		const resolved = path.resolve(route.endpoint.file);
		const relative = decodeURIComponent(path.relative(kit.files.routes, resolved));
		const name = posixify(path.join('entries/endpoints', relative.replace(/\.js$/, '')));
		input[name] = resolved;
	}
});

manifest_data.nodes.forEach((node) => {
	for (const file of [node.component, node.universal, node.server]) {
		if (file) {
			const resolved = path.resolve(file);
			const relative = decodeURIComponent(path.relative(kit.files.routes, resolved));

			const name = relative.startsWith('..')
				? posixify(path.join('entries/fallbacks', path.basename(file)))
				: posixify(path.join('entries/pages', relative.replace(/\.js$/, '')));

			input[name] = resolved;
		}
	}
});

Object.entries(manifest_data.matchers).forEach(([key, file]) => {
	const name = posixify(path.join('entries/matchers', key));
	input[name] = path.resolve(file);
});

const verbose = true;
const log = logger({ verbose });

/** @type {Record<string, string>} */
const client_input = {};

/** @type {Record<string, string>} */
const server_input = {};

for (const name in input) {
	const file = input[name];

	if (svelte_config.extensions.includes(path.extname(file))) {
		client_input[name] = file;
	} else {
		server_input[name] = file;
	}
}

// const is_build = true;

const prefix = `${kit.appDir}/immutable`;

// const version_hash = hash(kit.version.name);

// const global = is_build ? `globalThis.__sveltekit_${version_hash}` : `globalThis.__sveltekit_dev`;

const aliases = get_config_aliases(kit);

const { assets, base } = svelte_config.kit.paths;

const env_static_private_file = `${generated}/env/static/private.js`;

const env_static_private = create_static_module('$env/static/private', env.private);

fs_extra.outputFileSync(env_static_private_file, env_static_private);

const env_static_public_file = `${generated}/env/static/public.js`;

const env_static_public = create_static_module('$env/static/public', env.public);

fs_extra.outputFileSync(env_static_public_file, env_static_public);

const env_dynamic_private_file = `${generated}/env/private.js`;

const env_dynamic_private = create_dynamic_module('private', env.private);

fs_extra.outputFileSync(env_dynamic_private_file, env_dynamic_private);

const env_dynamic_public_file = `${generated}/env/public.js`;

const env_dynamic_public = create_dynamic_module('public', env.public);

fs_extra.outputFileSync(env_dynamic_public_file, env_dynamic_public);

const service_worker_file = `${generated}/service-worker.js`;

const service_worker = create_service_worker_module(svelte_config);

fs_extra.outputFileSync(service_worker_file, service_worker);

const sveltekit_paths_file = `${generated}/paths.js`;

const sveltekit_paths = dedent`
export let base = ${s(base)};
export let assets = ${assets ? s(assets) : 'base'};

export const relative = ${svelte_config.kit.paths.relative};

const initial = { base, assets };

export function override(paths) {
	base = paths.base;
	assets = paths.assets;
}

export function reset() {
	base = initial.base;
	assets = initial.assets;
}

/** @param {string} path */
export function set_assets(path) {
	assets = initial.assets = path;
}
`;

fs_extra.outputFileSync(sveltekit_paths_file, sveltekit_paths);

const sveltekit_environment_file = `${generated}/environment.js`;

const { version } = svelte_config.kit;

const sveltekit_environment = dedent`
export const version = ${s(version.name)};
export let building = false;

export function set_building() {
	building = true;
}
`;

fs_extra.outputFileSync(sveltekit_environment_file, sveltekit_environment);

copy(kit.files.assets, `${out}/${kit.appDir}`);

/** @type {import('esbuild').BuildOptions} */
const esbuild_config = {
	outdir: out,
	bundle: true,
	format: 'esm',
	metafile: true,
	platform: 'node',
	absWorkingDir: cwd,
	target: 'node16.14',
	allowOverwrite: true,
	// external: ['cheerio'],
	loader: { '.ts': 'ts' },
	entryPoints: server_input,
	chunkNames: 'chunks/[name].js',
	assetNames: `${prefix}/assets/[name].[hash][extname]`,
	define: {
		__SVELTEKIT_DEV__: 'true',
		__SVELTEKIT_EMBEDDED__: kit.embedded ? 'true' : 'false',
		__SVELTEKIT_APP_VERSION_FILE__: s(`${kit.appDir}/version.json`),
		__SVELTEKIT_APP_VERSION_POLL_INTERVAL__: s(kit.version.pollInterval)
	},
	alias: {
		$app: `${runtime_directory}/app`,
		__SERVER__: `${generated}/server`,

		'$env/static/public': env_static_public_file,
		'$env/static/private': env_static_private_file,

		'$env/dynamic/private': env_dynamic_private_file,
		'$env/dynamic/public': env_dynamic_public_file,

		'$service-worker': service_worker_file,

		'__sveltekit/paths': sveltekit_paths_file,
		'__sveltekit/environment': sveltekit_environment_file,

		...Object.fromEntries(aliases.map((alias) => [alias.find, alias.replacement]))
	}
};

const { metafile } = await esbuild.build(esbuild_config);

// console.log(metafile?.outputs);

/** @type {import('vite').Manifest} */
const client_manifest = {};

/** @type {import('vite').Manifest} */
const server_manifest = {};

for (let key in metafile?.outputs) {
	const output = metafile?.outputs[key];

	if (output.entryPoint) {
		server_manifest[output.entryPoint] = {
			src: output.entryPoint,
			file: path.relative(out, key),
			imports: output.imports.map((_import) => _import.path)
		};
	}
}

const parcel_config = url.fileURLToPath(
	new URL('../node_modules/@parcel/config-default', import.meta.url)
);

const parcel_cache = `${kit.outDir}/parcel_cache`;

rimraf(parcel_cache);

const parcel_bundler = new Parcel({
	mode,
	env: env.public,
	cacheDir: parcel_cache,
	defaultConfig: parcel_config,
	entries: Object.values(client_input).map((input) => path.relative(cwd, input)),
	defaultTargetOptions: { distDir: `${out}/${prefix}`, shouldOptimize: mode === 'production' }
});

let { bundleGraph } = await parcel_bundler.run();
let bundles = bundleGraph.getBundles();

for (const bundle of bundles) {
	const file = bundle.filePath;
	const entry = bundle.getMainEntry();

	if (entry) {
		const name = path.relative(cwd, entry.filePath);
		client_manifest[name] = { file, src: entry.filePath };
	}
}

// write_client_manifest(kit, manifest_data, `${output}/client`, client_manifest);

/** @type {import('types').BuildData} */
const build_data = {
	app_dir: kit.appDir,
	app_path: `${kit.paths.base.slice(1)}${kit.paths.base ? '/' : ''}${kit.appDir}`,
	manifest_data,
	service_worker: !!service_worker_entry_file ? 'service-worker.js' : null, // TODO make file configurable?
	client: null,
	server_manifest
};

const manifest_path = `${out}/manifest-full.js`;

fs.writeFileSync(
	manifest_path,
	`export const manifest = ${generate_manifest({
		build_data,
		relative_path: '.',
		routes: manifest_data.routes
	})};\n`
);

// first, build server nodes without the client manifest so we can analyse it
log.info('Analysing routes');

build_server_nodes(out, kit, manifest_data, server_manifest, client_manifest, null);

const metadata = await analyse({
	manifest_path,
	env: { ...env.private, ...env.public }
});

log.info('Building app');

// create client build
// write_client_manifest(
// 	kit,
// 	manifest_data,
// 	`${kit.outDir}/generated/client-optimized`,
// 	client_manifest,
// 	metadata.nodes
// );

// regenerate manifest now that we have client entry...
// fs.writeFileSync(
// 	manifest_path,
// 	`export const manifest = ${generate_manifest({
// 		build_data,
// 		relative_path: '.',
// 		routes: manifest_data.routes
// 	})};\n`
// );

// // regenerate nodes with the client manifest...
// build_server_nodes(out, kit, manifest_data, server_manifest, client_nodes_manifest, null);

// ...and prerender
const { prerendered, prerender_map } = await prerender({
	out,
	manifest_path,
	metadata,
	verbose,
	env: { ...env.private, ...env.public }
});

// generate a new manifest that doesn't include prerendered pages
fs.writeFileSync(
	`${out}/manifest.js`,
	`export const manifest = ${generate_manifest({
		build_data,
		relative_path: '.',
		routes: manifest_data.routes.filter((route) => prerender_map.get(route.id) !== true)
	})};\n`
);

// if (service_worker_entry_file) {
// 	if (kit.paths.assets) {
// 		throw new Error('Cannot use service worker alongside config.kit.paths.assets');
// 	}

// 	log.info('Building service worker');

// 	await build_service_worker(
// 		out,
// 		kit,
// 		manifest_data,
// 		service_worker_entry_file,
// 		prerendered,
// 		client_manifest
// 	);
// }

if (kit.adapter) {
	const { adapt } = await import('./core/adapt/index.js');
	await adapt(svelte_config, build_data, metadata, prerendered, prerender_map, log);
} else {
	console.log(colors.bold().yellow('\nNo adapter specified'));

	const link = colors.bold().cyan('https://kit.svelte.dev/docs/adapters');
	console.log(
		`See ${link} to learn how to configure your app to run on the platform of your choosing`
	);
}
