const fs = require('fs');
const path = require('path');

const BACKUP_PATTERN = /^sessions\.backup-\d{4}-\d{2}-\d{2}\.json$/;

function createJsonDbStore(options = {}) {
  const dataDir = options.dataDir;
  const fileName = options.fileName || 'sessions.json';
  const backupRetention = options.backupRetention || 7;
  const defaultData = typeof options.defaultData === 'function' ? options.defaultData : () => ({});
  const beforeSave = typeof options.beforeSave === 'function' ? options.beforeSave : null;
  const logger = options.logger || console;
  const dbFile = path.join(dataDir, fileName);

  function ensureDataDir() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  }

  function getBackupStamp(date = new Date()) {
    return date.toISOString().slice(0, 10);
  }

  function pruneBackups() {
    ensureDataDir();
    const backups = fs.readdirSync(dataDir)
      .filter((name) => BACKUP_PATTERN.test(name))
      .sort()
      .reverse();
    backups.slice(backupRetention).forEach((name) => {
      try {
        fs.unlinkSync(path.join(dataDir, name));
      } catch (err) {
        logger.error('backup cleanup error:', err?.message || err);
      }
    });
  }

  function backupOncePerDay() {
    try {
      ensureDataDir();
      if (!fs.existsSync(dbFile)) {
        pruneBackups();
        return;
      }
      const backupFile = path.join(dataDir, `sessions.backup-${getBackupStamp()}.json`);
      if (!fs.existsSync(backupFile)) {
        fs.copyFileSync(dbFile, backupFile);
      }
      pruneBackups();
    } catch (err) {
      logger.error('backupDbOncePerDay error:', err?.message || err);
    }
  }

  function load() {
    try {
      ensureDataDir();
      if (!fs.existsSync(dbFile)) {
        const initialDb = defaultData();
        fs.writeFileSync(dbFile, JSON.stringify(initialDb, null, 2), 'utf8');
        return initialDb;
      }
      backupOncePerDay();
      return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (err) {
      logger.error('loadDb error:', err);
      return defaultData();
    }
  }

  function save(db) {
    try {
      ensureDataDir();
      backupOncePerDay();
      if (beforeSave) beforeSave(db);
      fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
      return true;
    } catch (err) {
      logger.error('saveDb error:', err);
      return false;
    }
  }

  function getDiskInfo() {
    try {
      ensureDataDir();
      if (typeof fs.statfsSync !== 'function') return null;
      const stat = fs.statfsSync(dataDir);
      return {
        path: dataDir,
        freeBytes: Number(stat.bavail) * Number(stat.bsize),
        totalBytes: Number(stat.blocks) * Number(stat.bsize)
      };
    } catch (err) {
      logger.warn('disk info error:', err?.message || err);
      return { path: dataDir, freeBytes: null, totalBytes: null };
    }
  }

  return {
    dataDir,
    dbFile,
    ensureDataDir,
    backupOncePerDay,
    load,
    save,
    getDiskInfo
  };
}

module.exports = {
  createJsonDbStore
};
