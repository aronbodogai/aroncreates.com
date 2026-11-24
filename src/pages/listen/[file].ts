/**
 * Serves blog narration with HTTP range support.
 *
 * The MP3s are ordinary static files under /audio/blog, but Workers static
 * assets ignore `Range` and always answer 200 with the whole file. Safari
 * will not play media from a server that does that, and other browsers
 * cannot seek past what they have already buffered. This route reads the
 * same file through the ASSETS binding and answers ranges itself.
 *
 * Only files listed in src/data/blog-audio.json are served. Their names carry
 * a content hash, so responses are cacheable forever.
 *
 * Under the Node adapter (local `astro preview`) and `astro dev`, the static
 * server already supports ranges, so the request is forwarded as-is.
 */
import type { APIRoute } from 'astro';
import manifest from '../../data/blog-audio.json';

export const prerender = false;

declare const FixedLengthStream:
	| (new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> })
	| undefined;

const sizes = new Map(Object.values(manifest).map((a) => [a.src.split('/').pop()!, a.bytes]));

const handler: APIRoute = async ({ params, request }) => {
	const file = params.file ?? '';
	const size = sizes.get(file);
	if (size === undefined) return new Response('Not Found', { status: 404 });

	const range = request.headers.get('Range');
	const asset = await fetchAsset(new URL(`/audio/blog/${file}`, request.url), range);
	if (!asset.ok || !asset.body) return new Response('Not Found', { status: 404 });

	const headers = new Headers({
		'Content-Type': 'audio/mpeg',
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'public, max-age=31536000, immutable',
	});
	const head = request.method === 'HEAD';

	// The upstream handled the range (Node / Vite static servers).
	if (asset.status === 206) {
		for (const h of ['Content-Range', 'Content-Length']) {
			const v = asset.headers.get(h);
			if (v) headers.set(h, v);
		}
		return new Response(head ? null : asset.body, { status: 206, headers });
	}

	const span = parseRange(range, size);
	if (span === 'unsatisfiable') {
		await asset.body.cancel();
		headers.set('Content-Range', `bytes */${size}`);
		return new Response(null, { status: 416, headers });
	}
	if (!span) {
		headers.set('Content-Length', String(size));
		return new Response(head ? null : asset.body, { status: 200, headers });
	}

	const [start, end] = span;
	const length = end - start + 1;
	headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
	headers.set('Content-Length', String(length));
	if (head) {
		await asset.body.cancel();
		return new Response(null, { status: 206, headers });
	}
	return new Response(fixedLength(slice(asset.body, start, end), length), { status: 206, headers });
};

export const GET = handler;
export const HEAD = handler;

async function fetchAsset(url: URL, range: string | null): Promise<Response> {
	if (navigator.userAgent === 'Cloudflare-Workers') {
		// Kept out of the static import graph so the Node build never resolves it.
		const specifier = 'cloudflare:workers';
		const { env } = await import(/* @vite-ignore */ specifier);
		return env.ASSETS.fetch(url);
	}
	return fetch(url, { headers: range ? { Range: range } : {} });
}

/** A single `bytes=` range as inclusive [start, end]; null means "send it all". */
function parseRange(header: string | null, size: number): [number, number] | null | 'unsatisfiable' {
	const m = header?.match(/^bytes=(\d*)-(\d*)$/);
	if (!m || (m[1] === '' && m[2] === '')) return null; // absent, malformed, or multi-range
	let start: number;
	let end: number;
	if (m[1] === '') {
		const suffix = Number(m[2]);
		if (suffix === 0) return 'unsatisfiable';
		start = Math.max(0, size - suffix);
		end = size - 1;
	} else {
		start = Number(m[1]);
		end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
	}
	return start >= size || start > end ? 'unsatisfiable' : [start, end];
}

/** Bytes start..end (inclusive) of a stream, without buffering the file. */
function slice(body: ReadableStream<Uint8Array>, start: number, end: number): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let pos = 0;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) return controller.close();
				const chunkStart = pos;
				pos += value.byteLength;
				if (pos <= start) continue;
				controller.enqueue(value.subarray(Math.max(0, start - chunkStart), Math.min(value.byteLength, end + 1 - chunkStart)));
				if (pos > end) {
					controller.close();
					await reader.cancel();
				}
				return;
			}
		},
		cancel: (reason) => reader.cancel(reason),
	});
}

/** On Workers, a JS-produced stream is sent chunked unless its length is declared. */
function fixedLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
	if (typeof FixedLengthStream === 'undefined') return stream;
	const { readable, writable } = new FixedLengthStream(length);
	stream.pipeTo(writable).catch(() => {});
	return readable;
}
