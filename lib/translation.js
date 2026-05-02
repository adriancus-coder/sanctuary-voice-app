const fs = require('fs');

function createTranslationService(options = {}) {
  const client = options.client || null;
  const logger = options.logger || console;

  async function translateWithResponses({ model, input }) {
    if (!client) return '';
    const response = await client.responses.create({ model, input });
    return String(response.output_text || '').trim();
  }

  async function translateWithResponsesDetailed({ model, input }) {
    if (!client) return { text: '', tokens: 0 };
    const response = await client.responses.create({ model, input });
    const text = String(response.output_text || '').trim();
    const usage = response.usage || {};
    const tokens = Number(usage.total_tokens || 0)
      || (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0))
      || 0;
    return { text, tokens };
  }

  async function translateWithResponsesStreaming({ model, input, onDelta }) {
    if (!client) return { text: '', tokens: 0 };
    const stream = await client.responses.create({ model, input, stream: true });
    let fullText = '';
    let tokens = 0;
    try {
      for await (const event of stream) {
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          fullText += event.delta;
          if (typeof onDelta === 'function') {
            try { onDelta(fullText); } catch (err) { logger.warn?.('onDelta callback failed:', err?.message || err); }
          }
        } else if (event.type === 'response.completed') {
          const usage = event.response?.usage || {};
          tokens = Number(usage.total_tokens || 0)
            || (Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0))
            || 0;
        }
      }
    } catch (err) {
      logger.error?.('streaming translate failed:', err?.message || err);
      throw err;
    }
    return { text: fullText.trim(), tokens };
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
