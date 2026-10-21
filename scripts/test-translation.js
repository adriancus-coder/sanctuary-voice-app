// SV-MODEL-SWITCHES tests — the translation wrapper builds the OpenAI request
// additively: no `reasoning` unless a reasoning effort is passed, and cached
// input tokens are read from the usage. Mocked client, no network. Exit 0/1.
const assert = require('assert');
const { createTranslationService } = require('../lib/translation');
// LIVE-V2-PROMPT — the v2 live prompt builder (stable prefix + context + clause).
const { buildLiveV2Messages, buildStableSystemPrompt } = require('../lib/live-v2/prompt');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.error('FAIL  ' + name + '\n      ' + (e && e.message)); }
}

function mockClient(response) {
  const calls = [];
  return {
    calls,
    responses: {
      create: async (req) => { calls.push(req); return response; }
    }
  };
}

(async () => {
  await test('no reasoning field for a non-reasoning model (gpt-4.1)', async () => {
    const client = mockClient({ output_text: 'salut', usage: { total_tokens: 10, input_tokens_details: { cached_tokens: 4 } } });
    const svc = createTranslationService({ client });
    const out = await svc.translateWithResponsesDetailed({ model: 'gpt-4.1-nano', input: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(out.text, 'salut');
    assert.strictEqual(out.tokens, 10);
    assert.strictEqual(out.cachedTokens, 4, 'cached tokens read from input_tokens_details');
    assert.ok(!('reasoning' in client.calls[0]), 'request has no reasoning field by default');
  });

  await test('reasoning effort forwarded for a GPT-5 model', async () => {
    const client = mockClient({ output_text: 'hei', usage: { input_tokens: 7, output_tokens: 3 } });
    const svc = createTranslationService({ client });
    await svc.translateWithResponsesDetailed({ model: 'gpt-5-nano', input: [{ role: 'user', content: 'hi' }], reasoningEffort: 'minimal' });
    assert.deepStrictEqual(client.calls[0].reasoning, { effort: 'minimal' }, 'reasoning.effort set');
  });

  await test('streaming path reports tokens + cached and forwards reasoning', async () => {
    async function* stream() {
      yield { type: 'response.output_text.delta', delta: 'a' };
      yield { type: 'response.output_text.delta', delta: 'b' };
      yield { type: 'response.completed', response: { usage: { total_tokens: 20, input_tokens_details: { cached_tokens: 9 } } } };
    }
    const client = { calls: [], responses: { create: async (req) => { client.calls.push(req); return stream(); } } };
    const svc = createTranslationService({ client });
    let last = '';
    const out = await svc.translateWithResponsesStreaming({ model: 'gpt-5-mini', input: [{ role: 'user', content: 'x' }], onDelta: (t) => { last = t; }, reasoningEffort: 'minimal' });
    assert.strictEqual(out.text, 'ab');
    assert.strictEqual(last, 'ab');
    assert.strictEqual(out.tokens, 20);
    assert.strictEqual(out.cachedTokens, 9);
    assert.deepStrictEqual(client.calls[0].reasoning, { effort: 'minimal' });
    assert.strictEqual(client.calls[0].stream, true);
  });

  await test('no client => empty result, no throw', async () => {
    const svc = createTranslationService({ client: null });
    const out = await svc.translateWithResponsesDetailed({ model: 'gpt-4.1-nano', input: [] });
    assert.deepStrictEqual(out, { text: '', tokens: 0, cachedTokens: 0 });
  });

  // ---- LIVE-V2-PROMPT -------------------------------------------------------
  await test('v2 prompt: stable system first, glossary + mode rule, clause last', () => {
    const msgs = buildLiveV2Messages({
      sourceLangName: 'Romanian',
      targetLangName: 'English',
      speed: 'interpret',
      glossary: { Duh: 'Spirit' },
      contextClauses: [],
      clause: 'și ne iubește',
      endsSentence: false
    });
    assert.strictEqual(msgs[0].role, 'system', 'stable system prompt is first');
    assert.ok(/from Romanian to English/.test(msgs[0].content), 'names the language pair');
    assert.ok(/Duh => Spirit/.test(msgs[0].content), 'glossary embedded in stable prefix');
    assert.ok(/consecutive interpreter/.test(msgs[0].content), 'interpret mode condensation kept');
    assert.ok(/Do not use ellipses/.test(msgs[0].content), 'no-ellipsis rule present');
    const lastUser = msgs[msgs.length - 1];
    assert.strictEqual(lastUser.role, 'user');
    assert.strictEqual(lastUser.content, 'și ne iubește', 'clause is the final user message, alone');
  });

  await test('v2 prompt: last 2 committed clauses become context pairs', () => {
    const msgs = buildLiveV2Messages({
      sourceLangName: 'Romanian', targetLangName: 'English', speed: 'balanced', glossary: {},
      contextClauses: [
        { source: 'a1', translation: 'b1' },
        { source: 'a2', translation: 'b2' },
        { source: 'a3', translation: 'b3' } // only the last 2 should survive
      ],
      clause: 'c', endsSentence: false
    });
    const users = msgs.filter((m) => m.role === 'user').map((m) => m.content);
    const assts = msgs.filter((m) => m.role === 'assistant').map((m) => m.content);
    assert.deepStrictEqual(users, ['a2', 'a3', 'c'], 'last 2 context sources + the clause');
    assert.deepStrictEqual(assts, ['b2', 'b3'], 'last 2 context translations');
    const directive = msgs.find((m) => m.role === 'system' && /do not repeat/i.test(m.content));
    assert.ok(directive, 'context is explicitly marked do-not-repeat');
  });

  await test('v2 prompt: endsSentence toggles the terminal-punctuation rule', () => {
    const mid = buildLiveV2Messages({ sourceLangName: 'Romanian', targetLangName: 'English', speed: 'balanced', glossary: {}, contextClauses: [], clause: 'x', endsSentence: false });
    const end = buildLiveV2Messages({ sourceLangName: 'Romanian', targetLangName: 'English', speed: 'balanced', glossary: {}, contextClauses: [], clause: 'x', endsSentence: true });
    const directiveOf = (msgs) => msgs.find((m) => m.role === 'system' && /Translate ONLY the new fragment/.test(m.content)).content;
    assert.ok(/does NOT end a sentence/.test(directiveOf(mid)), 'mid-clause: no terminal punctuation');
    assert.ok(/do not add a final period/i.test(directiveOf(mid)));
    assert.ok(/ends a sentence/.test(directiveOf(end)), 'final clause: close the sentence');
    assert.ok(/no leading capital|Do not capitalize/i.test(directiveOf(mid)), 'no-leading-capital rule present');
  });

  await test('v2 prompt: stable prefix is identical regardless of clause/context (caching)', () => {
    const a = buildStableSystemPrompt('Romanian', 'English', 'balanced', { Duh: 'Spirit' });
    const b = buildStableSystemPrompt('Romanian', 'English', 'balanced', { Duh: 'Spirit' });
    assert.strictEqual(a, b, 'same inputs → byte-identical prefix');
    const fromFull = buildLiveV2Messages({ sourceLangName: 'Romanian', targetLangName: 'English', speed: 'balanced', glossary: { Duh: 'Spirit' }, contextClauses: [{ source: 's', translation: 't' }], clause: 'anything', endsSentence: true })[0].content;
    assert.strictEqual(fromFull, a, 'prefix unaffected by context/clause/endsSentence');
  });

  if (failures) { console.error(`\ntranslation tests: ${failures} failure(s)`); process.exit(1); }
  console.log('\ntranslation tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
