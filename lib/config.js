'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILES = [
  'tunnel-daddy.config.json',
  '.tunnel-daddy.json',
  '.tunnel-daddyrc.json',
];

/**
 * Load tunnel configuration for a project directory.
 *
 * Search order:
 *   1. tunnel-daddy.config.json
 *   2. .tunnel-daddy.json
 *   3. .tunnel-daddyrc.json
 *   4. "tunnelDaddy" key in package.json
 *
 * @param {string} [cwd] project directory (defaults to process.cwd())
 * @returns {{ tunnels: Array<{name?: string, hostname: string, url: string}> }}
 */
function loadConfig(cwd = process.cwd()) {
  for (const file of CONFIG_FILES) {
    const full = path.join(cwd, file);
    if (fs.existsSync(full)) {
      const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
      return validateConfig(parsed, full);
    }
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.tunnelDaddy) {
      return validateConfig(pkg.tunnelDaddy, `${pkgPath}#tunnelDaddy`);
    }
  }

  throw new Error(
    `tunnel-daddy: no config found in ${cwd}. ` +
      `Create tunnel-daddy.config.json or add a "tunnelDaddy" key to package.json.`
  );
}

function validateConfig(config, source) {
  if (!config || !Array.isArray(config.tunnels) || config.tunnels.length === 0) {
    throw new Error(`tunnel-daddy: config at ${source} must have a non-empty "tunnels" array`);
  }
  for (const tunnel of config.tunnels) {
    if (!tunnel.hostname || !tunnel.url) {
      throw new Error(
        `tunnel-daddy: every tunnel in ${source} needs "hostname" and "url" (got ${JSON.stringify(tunnel)})`
      );
    }
  }
  return config;
}

module.exports = { loadConfig, validateConfig };
