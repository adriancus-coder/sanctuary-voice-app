// SV-MODEL-SWITCHES tests — the translation wrapper builds the OpenAI request
// additively: no `reasoning` unless a reasoning effort is passed, and cached
// input tokens are read from the usage. Mocked client, no network. Exit 0/1.
const assert = require('assert');
const { createTranslationService } = require('../lib/translation');

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

  if (failures) { console.error(`\ntranslation tests: ${failures} failure(s)`); process.exit(1); }
  console.log('\ntranslation tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
