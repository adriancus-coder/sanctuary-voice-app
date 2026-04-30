const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 3;

function serializePart(part) {
  if (part instanceof Error) return part.stack || part.message;
  if (typeof part === 'string') return part;
  try {
    return JSON.stringify(part);
  } catch (_) {
    return String(part);
  }
}

function createLogger(options = {}) {
  const logDir = options.logDir || path.join(process.cwd(), 'logs');
  const fileName = options.fileName || 'app.log';
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const retainedFiles = options.retainedFiles || DEFAULT_RETAINED_FILES;
  const logFile = path.join(logDir, fileName);

  function ensureLogDir() {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  }

  function rotateIfNeeded() {
    ensureLogDir();
    if (!fs.existsSync(logFile)) return;
    const size = fs.statSync(logFile).size;
    if (size < maxBytes) return;

    for (let index = retainedFiles - 1; index >= 1; index -= 1) {
      const source = `${logFile}.${index}`;
      const target = `${logFile}.${index + 1}`;
      if (fs.existsSync(source)) {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        fs.renameSync(source, target);
      }
    }

    const firstArchive = `${logFile}.1`;
    if (fs.existsSync(firstArchive)) fs.unlinkSync(firstArchive);
    fs.renameSync(logFile, firstArchive);
  }

  function write(level, ...parts) {
    try {
      rotateIfNeeded();
      const message = parts.map(serializePart).join(' ');
      const line = `${new Date().toISOString()} ${level} ${message}\n`;
      fs.appendFileSync(logFile, line, 'utf8');
    } catch (err) {
      process.stderr.write(`logger failed: ${err?.message || err}\n`);
    }
  }

  return {
    file: logFile,
    info: (...parts) => write('INFO', ...parts),
    warn: (...parts) => write('WARN', ...parts),
    error: (...parts) => write('ERROR', ...parts)
  };
}

module.exports = {
  createLogger
};
