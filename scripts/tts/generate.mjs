#!/usr/bin/env node
/**
 * Pre-generates narration audio for blog posts.
 *
 *   pnpm tts                    generate audio for new or changed posts
 *   pnpm tts <slug>...          only these posts
 *   pnpm tts --force [slug...]  regenerate even if unchanged
 *   pnpm tts --check            exit 1 if any post's audio is missing or stale
 *   pnpm tts --text <slug>      print the narration script, generate nothing
 *   pnpm tts --phonemes <slug>  print Kokoro's phonemes for each chunk
 *
 * Text extraction runs here (extract.mjs); synthesis runs in synth.py under
 * `uv`, which provisions Python, torch, and Kokoro on first use. Output goes
 * to public/audio/blog/<slug>-<hash>.mp3, and src/data/blog-audio.json
 * records what was generated from which text so unchanged posts are skipped.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNarration } from './extract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POSTS_DIR = join(root, 'src/content/blog');
const AUDIO_DIR = join(root, 'public/audio/blog');
const MANIFEST = join(root, 'src/data/blog-audio.json');
const SYNTH = join(root, 'scripts/tts/synth.py');

/**
 * Everything that changes the audio for the same text. Bump `revision` when
 * synth.py changes in a way that should regenerate every post.
 */
const SETTINGS = {
	engine: 'kokoro-82m',
	revision: 1,
	lang: 'a', // American English
	voice: 'af_heart',
	speed: 1,
	bitrate: 64, // kbps, mono 24 kHz MP3
};

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const only = argv.filter((a) => !a.startsWith('--'));

const posts = readdirSync(POSTS_DIR)
	.filter((f) => /\.mdx?$/.test(f))
	.map((f) => {
		const slug = f.replace(/\.mdx?$/, '');
		const narration = extractNarration(readFileSync(join(POSTS_DIR, f), 'utf8'));
		const hash = createHash('sha256')
			.update(JSON.stringify({ settings: SETTINGS, chunks: narration.chunks }))
			.digest('hex')
			.slice(0, 12);
		return { slug, hash, ...narration };
	})
	.filter((p) => only.length === 0 || only.includes(p.slug));

for (const slug of only) {
	if (!posts.some((p) => p.slug === slug)) fail(`no post named "${slug}" in ${relative(root, POSTS_DIR)}`);
}

if (flags.has('--text')) {
	for (const post of posts) {
		console.log(`\n=== ${post.slug} (${post.chunks.length} chunks, hash ${post.hash})\n`);
		for (const c of post.chunks) console.log(`${c.text}  [${c.pause}ms]`);
	}
	process.exit(0);
}

if (flags.has('--phonemes')) {
	for (const post of posts) runSynth(post, join(mkdtempSync(join(tmpdir(), 'tts-')), 'unused.mp3'), ['--phonemes']);
	process.exit(0);
}

/** @type {Record<string, { src: string, hash: string, duration: number, bytes: number, voice: string, engine: string }>} */
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
const isCurrent = (p) => manifest[p.slug]?.hash === p.hash && existsSync(join(root, 'public', manifest[p.slug].src));

if (flags.has('--check')) {
	const stale = posts.filter((p) => !isCurrent(p));
	for (const p of stale) console.log(`${p.slug}: ${manifest[p.slug] ? 'stale' : 'missing'}`);
	console.log(stale.length ? `\n${stale.length} post(s) need \`pnpm tts\`.` : 'All narration is current.');
	process.exit(stale.length ? 1 : 0);
}

const todo = posts.filter((p) => flags.has('--force') || !isCurrent(p));
if (todo.length === 0) console.log('All narration is current.');

for (const post of todo) {
	const file = `${post.slug}-${post.hash}.mp3`;
	console.log(`\n${post.slug}: synthesising ${post.chunks.length} chunks`);
	const result = runSynth(post, join(AUDIO_DIR, file));

	// Drop this post's previous files; the hash in the name makes each one immutable.
	for (const old of readdirSync(AUDIO_DIR)) {
		if (old !== file && old.startsWith(`${post.slug}-`) && /^[0-9a-f]{12}\.mp3$/.test(old.slice(post.slug.length + 1))) {
			rmSync(join(AUDIO_DIR, old));
		}
	}
	manifest[post.slug] = {
		src: `/audio/blog/${file}`,
		hash: post.hash,
		duration: result.duration,
		bytes: result.bytes,
		voice: SETTINGS.voice,
		engine: SETTINGS.engine,
	};
	writeManifest();
	console.log(`${post.slug}: ${fmtDuration(result.duration)}, ${(result.bytes / 1e6).toFixed(1)} MB`);
}

// Forget posts that were deleted or renamed, and their audio.
if (only.length === 0) {
	const slugs = new Set(posts.map((p) => p.slug));
	for (const slug of Object.keys(manifest)) {
		if (slugs.has(slug)) continue;
		rmSync(join(root, 'public', manifest[slug].src), { force: true });
		delete manifest[slug];
		console.log(`${slug}: post gone, removed its audio`);
	}
	writeManifest();
}

function runSynth(post, out, extraArgs = []) {
	const dir = mkdtempSync(join(tmpdir(), 'tts-'));
	const job = join(dir, 'job.json');
	writeFileSync(job, JSON.stringify({ ...SETTINGS, out, chunks: post.chunks }));
	try {
		const res = spawnSync('uv', ['run', '--quiet', SYNTH, job, ...extraArgs], {
			stdio: ['ignore', extraArgs.length ? 'inherit' : 'pipe', 'inherit'],
			encoding: 'utf8',
		});
		if (res.error?.code === 'ENOENT') fail('`uv` not found. Install it: https://docs.astral.sh/uv/');
		if (res.status !== 0) fail(`synth.py failed for ${post.slug} (exit ${res.status})`);
		return extraArgs.length ? null : JSON.parse(res.stdout.trim().split('\n').at(-1));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeManifest() {
	const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
	writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, '\t')}\n`);
}

function fmtDuration(s) {
	return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

function fail(msg) {
	console.error(`tts: ${msg}`);
	process.exit(1);
}
