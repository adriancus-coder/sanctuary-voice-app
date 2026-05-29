// V22.13 — AudioWorklet processor pentru captura PCM (Azure path).
// V22.16 — tamponează la ~4096 sample-uri înainte de a trimite (ca ScriptProcessor),
// altfel process() la 128 sample-uri inunda serverul → 429.
class AzurePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(4096);
    this._fill = 0;
  }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      let i = 0;
      while (i < ch.length) {
        const space = this._buf.length - this._fill;
        const take = Math.min(space, ch.length - i);
        this._buf.set(ch.subarray(i, i + take), this._fill);
        this._fill += take;
        i += take;
        if (this._fill >= this._buf.length) {
          this.port.postMessage(this._buf.slice(0));
          this._fill = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('azure-pcm-processor', AzurePcmProcessor);
