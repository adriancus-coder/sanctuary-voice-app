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
    transcribeAudioFile
  };
}

module.exports = {
  createTranslationService
};
