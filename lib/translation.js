const fs = require('fs');

function createTranslationService(options = {}) {
  const client = options.client || null;
  const logger = options.logger || console;

  // SV-MODEL-SWITCHES — reasoning models (GPT-5 family) accept a reasoning effort.
  // Build the request additively: without reasoningEffort the request is byte-for-
  // byte what it was before, so existing (gpt-4.1) behaviour is unchanged.
  function buildRequest(base, reasoningEffort) {
    const req = { ...base };
    if (reasoningEffort) req.reasoning = { effort: reasoningEffort };
    return req;
  }

  function usageTokens(usage = {}) {
    const total = Number(usage.total_tokens || 0)
      || (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0))
      || 0;
    const cached = Number(
      (usage.input_tokens_details && usage.input_tokens_details.cached_tokens)
      || (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
      || 0
    ) || 0;
    return { total, cached };
  }

  async function translateWithResponses({ model, input, reasoningEffort }) {
    if (!client) return '';
    const response = await client.responses.create(buildRequest({ model, input }, reasoningEffort));
    return String(response.output_text || '').trim();
  }

  async function translateWithResponsesDetailed({ model, input, reasoningEffort }) {
    if (!client) return { text: '', tokens: 0, cachedTokens: 0 };
    const response = await client.responses.create(buildRequest({ model, input }, reasoningEffort));
    const text = String(response.output_text || '').trim();
    const { total, cached } = usageTokens(response.usage || {});
    return { text, tokens: total, cachedTokens: cached };
  }

  async function translateWithResponsesStreaming({ model, input, onDelta, signal, reasoningEffort }) {
    if (!client) return { text: '', tokens: 0, cachedTokens: 0 };
    // V22.34 — signal pasat ca RequestOptions (al 2-lea arg) — forma SDK OpenAI v4
    const stream = await client.responses.create(buildRequest({ model, input, stream: true }, reasoningEffort), signal ? { signal } : undefined);
    let fullText = '';
    let tokens = 0;
    let cachedTokens = 0;
    try {
      for await (const event of stream) {
        if (signal && signal.aborted) break;   // V22.34 — oprește iterarea la abort
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          fullText += event.delta;
          if (typeof onDelta === 'function') {
            try { onDelta(fullText); } catch (err) { logger.warn?.('onDelta callback failed:', err?.message || err); }
          }
        } else if (event.type === 'response.completed') {
          const { total, cached } = usageTokens(event.response?.usage || {});
          tokens = total;
          cachedTokens = cached;
        }
      }
    } catch (err) {
      if (signal && signal.aborted) return { text: fullText.trim(), tokens, cachedTokens };   // abort = normal, nu eroare
      logger.error?.('streaming translate failed:', err?.message || err);
      throw err;
    }
    return { text: fullText.trim(), tokens, cachedTokens };
  }

  async function transcribeAudioFile({ filePath, model, prompt, language }) {
    if (!client) return '';
    const request = {
      file: fs.createReadStream(filePath),
      model,
      response_format: 'json',
      prompt
    };
    if (language) request.language = language;
    const result = await client.audio.transcriptions.create(request);
    return String(result?.text || '').trim();
  }

  return {
    logger,
    translateWithResponses,
    translateWithResponsesDetailed,
    translateWithResponsesStreaming,
    transcribeAudioFile
  };
}

module.exports = {
  createTranslationService
};
