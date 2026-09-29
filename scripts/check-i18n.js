// SV-CHECK — i18n parity. Loads the dictionary from public/admin-i18n.js in a
// tiny sandbox and verifies ro/en are in parity (a key in one but not the other
// fails). Norwegian (no) is optional: missing keys are reported as en fallbacks,
// not failures.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadDict() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin-i18n.js'), 'utf8');
  const noop = () => {};
  const doc = {
    querySelectorAll: () => [],
    addEventListener: noop,
    documentElement: { setAttribute: noop },
  };
  const sandbox = {
    window: {},
    document: doc,
    localStorage: { getItem: () => null, setItem: noop },
    navigator: { language: 'ro' },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  if (!sandbox.window.adminI18n || !sandbox.window.adminI18n.dict) {
    throw new Error('could not load window.adminI18n.dict from admin-i18n.js');
  }
  return sandbox.window.adminI18n.dict;
}

function main() {
  const dict = loadDict();
  const required = ['ro', 'en'];
  for (const lang of required) {
    if (!dict[lang]) {
      console.error(`FAIL  required language "${lang}" missing from dictionary`);
      process.exit(1);
    }
  }
  const baseKeys = Object.keys(dict.ro);
  const enKeys = Object.keys(dict.en);
  const missingInEn = baseKeys.filter((k) => !(k in dict.en));
  const extraInEn = enKeys.filter((k) => !(k in dict.ro));

  let failed = false;
  if (missingInEn.length) {
    failed = true;
    console.error(`FAIL  ${missingInEn.length} key(s) in ro but missing in en:`);
    missingInEn.slice(0, 20).forEach((k) => console.error('        ' + k));
  }
  if (extraInEn.length) {
    failed = true;
    console.error(`FAIL  ${extraInEn.length} key(s) in en but missing in ro:`);
    extraInEn.slice(0, 20).forEach((k) => console.error('        ' + k));
  }

  // Norwegian: optional, report only.
  if (dict.no) {
    const missingInNo = baseKeys.filter((k) => !(k in dict.no));
    if (missingInNo.length) {
      console.log(
        `note  ${missingInNo.length} key(s) not translated in "no" — they fall back to en (not a failure).`
      );
    }
  } else {
    console.log('note  no Norwegian dictionary present — en is used everywhere (not a failure).');
  }

  if (failed) {
    console.error('\ni18n parity check failed');
    process.exit(1);
  }
  console.log(`i18n parity OK — ${baseKeys.length} keys, ro/en in parity.`);
}

main();
