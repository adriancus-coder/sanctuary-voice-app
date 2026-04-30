const fs = require('fs');

function createTranslationService(options = {}) {
  const client = options.client || null;
  const logger = options.logger || console;

  async function translateWithResponses({ model, input }) {
    if (!client) return '';
    const response = await client.responses.create({ model, input });
    return String(response.output_text || '').trim();
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
    transcribeAudioFile
  };
}

module.exports = {
  createTranslationService
};
