/** The TypeSafe Adapter receives only bounded approved data and rejects incomplete judgments. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRequest, decodeResponse, requestJev, literalKey, readKey } from "../lib/jev-client.ts";

const candidates = [{ id: "c0", text: "obsolete lookup" }];
const request = () => makeRequest("Fix the parser", candidates);
const response = () => ({ model: "jev-1.13.0", answers: { c0: { type: "noul", noul: 0.02 } }, usage: { input_tokens: 100, output_tokens: 10 } });

test("payload contains complete text and explicit task only; bounded limits reject overflow", () => {
	const payload = request();
	assert.deepEqual(Object.keys(payload).sort(), ["model", "questions", "state"]);
	assert.deepEqual(payload.state, { task: "Fix the parser", candidates });
	assert.match(payload.questions.c0.instructions, /c0/);
	assert.throws(() => makeRequest("x".repeat(2049), candidates));
	assert.throws(() => makeRequest("task", [{ id: "c0", text: "x".repeat(6001) }]));
	assert.throws(() => makeRequest("task", []));
	assert.throws(() => makeRequest("task", [...candidates, ...candidates]));
});

test("closed response schema rejects wrong IDs, extras, nonfinite and non-probability values", () => {
	assert.equal(decodeResponse(response(), ["c0"]).probabilities.get("c0"), 0.02);
	for (const noul of [NaN, Infinity, -1, 1.01, true, "0", null]) {
		assert.throws(() => decodeResponse({ ...response(), answers: { c0: { type: "noul", noul } } }, ["c0"]));
	}
	assert.throws(() => decodeResponse({ ...response(), extra: true }, ["c0"]));
	assert.throws(() => decodeResponse({ ...response(), answers: {} }, ["c0"]));
	assert.throws(() => decodeResponse({ ...response(), usage: { input_tokens: 1e100, output_tokens: 1 } }, ["c0"]));
	assert.throws(() => decodeResponse({ ...response(), answers: { c0: { type: "noul", noul: 0, confidence: 1 } } }, ["c0"]));
});

test("transport uses fixed HTTPS, no redirects, bounded body and abortable requests", async () => {
	let calls = 0;
	const transport: typeof fetch = async (url, options) => {
		calls++;
		assert.equal(url, "https://api.typesafe.ai/v1/systemone");
		assert.equal(options?.redirect, "error");
		assert.equal(options?.method, "POST");
		assert.equal(options?.body, JSON.stringify(request(), null, 2), "wire bytes match the complete approved preview");
		assert.ok(options?.signal);
		return new Response(JSON.stringify(response()));
	};
	const result = await requestJev(request(), "fixture-key", new AbortController().signal, transport);
	assert.equal(calls, 1);
	assert.equal(result.usage.input_tokens, 100);
	assert.ok(result.elapsedMs >= 0);
	await assert.rejects(requestJev(request(), "fixture-key", new AbortController().signal,
		async () => new Response("x".repeat(65537))), /response/i);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(requestJev(request(), "fixture-key", controller.signal, transport));
	assert.equal(calls, 1);
});

test("deadline covers hanging headers and streaming; rejected response bodies are cancelled", async () => {
	await assert.rejects(requestJev(request(), "fixture-key", new AbortController().signal,
		async () => new Promise<Response>(() => {}), 10), /deadline/i);
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
	await assert.rejects(requestJev(request(), "fixture-key", new AbortController().signal, async () => new Response(body), 10), /deadline/i);
	assert.equal(cancelled, true);
	let rejectedCancelled = false;
	await assert.rejects(requestJev(request(), "fixture-key", new AbortController().signal,
		async () => new Response(new ReadableStream({ cancel() { rejectedCancelled = true; } }), { status: 302 })), /HTTP 302/);
	assert.equal(rejectedCancelled, true);
	await assert.rejects(requestJev(request(), "fixture-key", new AbortController().signal,
		async () => new Response(new Uint8Array([0xff]))));
});

test("credential fallback reads only a bounded literal assignment", () => {
	const directory = mkdtempSync(join(tmpdir(), "jev-key-fixture-"));
	const file = join(directory, "shell-config");
	assert.equal(readKey({ TYPESAFE_API_KEY: "primary", TYPESAFE_KEY: "secondary" }, file), "primary");
	writeFileSync(file, 'export TYPESAFE_KEY="fixture-key" # literal\n');
	assert.equal(readKey({}, file), "fixture-key");
	for (const content of ['export TYPESAFE_KEY="$(forbidden)"', 'TYPESAFE_KEY=a\nTYPESAFE_KEY=b', "x".repeat(262145)]) {
		writeFileSync(file, content);
		assert.throws(() => readKey({}, file));
	}
});

test("credentials are literal and never evaluated as shell or environment expressions", () => {
	assert.equal(literalKey("fixture-key"), "fixture-key");
	for (const key of ["", "$(command)", "`command`", "key;command", "has space", "line\nkey"]) assert.throws(() => literalKey(key));
});
