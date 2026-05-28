// V22.13 — AudioWorklet processor pentru captura PCM (Azure path).
// Rulează pe thread audio separat. Transportă frame-uri raw (Float32) la main thread
// prin port; gating + downsample + emit se fac în main thread (app.js).
class AzurePcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor('azure-pcm-processor', AzurePcmProcessor);
