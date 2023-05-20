import {assets} from '$app/paths'

/** @type {import('@sveltejs/kit').Load}*/
export async function load({ fetch }) {
	const res = await fetch('/answer.json');
	const { answer } = await res.json();
	console.log(assets);
	return { answer: 10 };
}
