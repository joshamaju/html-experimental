// import adapter from '@sveltejs/adapter-node';

import adapter from '@sveltejs/adapter-vercel';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),

		prerender: {
			handleHttpError: 'warn'
		},

		version: {
			name: 'TEST_VERSION'
		}
	}
};

export default config;
