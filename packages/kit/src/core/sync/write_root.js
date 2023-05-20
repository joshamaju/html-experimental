import { dedent, write_if_changed } from './utils.js';
import url from 'node:url'
import path from 'node:path'

/**
 * @param {import('types').ManifestData} manifest_data
 * @param {string} output
 */
export function write_root(manifest_data, output) {
	// TODO remove default layout altogether

	const max_depth = Math.max(
		...manifest_data.routes.map((route) =>
			route.page ? route.page.layouts.filter(Boolean).length + 1 : 0
		),
		1
	);

	const levels = [];
	for (let i = 0; i <= max_depth; i += 1) {
		levels.push(i);
	}

	let l = max_depth;

	let pyramid = `constructors[${l}].render({ ...props, data: props.data_${l} })`;

	while (l--) {
		// let segments = [
		// 	`constructors[${l + 1}] ?`,
		// 	`constructors[${l}].render({ data: props.data_${l} }).replace('<slot></slot>', ${pyramid})`,
		// 	`: constructors[${l}].render({ data: props.data_${l} })`
		// ];

		let segments = [
			`constructors[${l + 1}] ?`,
			`(() => {
				const result = constructors[${l}].render({ ...props, data: props.data_${l} });

				const $ = parseDoc(result);

				const slotted = ${pyramid};

				const $$ = parseDoc(slotted);

				$('title').replaceWith($$('title'));

				$("head").append($$('head'));

				$('slot').replaceWith($$('body'));

				$$("body").each(function() {
					this.attributes.forEach(attr => {
						if (attr.name === 'class') {
							$("body").addClass(attr.value)
						} else {
							$("body").attr(attr.name, attr.value);
						}
					})
				});

				$$('html').each(function() {
					this.attributes.forEach(attr => {
						if (attr.name === 'class') {
							$('html').addClass(attr.value)
						} else {
							$('html').attr(attr.name, attr.value);
						}
					})
				});

				return $.root().html()
			})()`,
			`: constructors[${l}].render({ ...props, data: props.data_${l} })`
		];

		pyramid = segments.join(' ');
	}

	const cheerio = url.fileURLToPath(new URL('../../../node_modules/cheerio', import.meta.url).href)

	write_if_changed(
		`${output}/root.js`,
		dedent`
		import {load as parseDoc} from "${path.relative(output, cheerio)}";

		export default {
			render({constructors, ...props}) {
				return ${pyramid};
			}
		}
		`
	);
}
