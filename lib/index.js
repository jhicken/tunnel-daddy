'use strict';

const { Tunnel, stateRoot } = require('./tunnel');
const { loadConfig } = require('./config');

/**
 * Start all configured tunnels for this project.
 *
 * Tunnels are shared machine-wide: if another project already opened the same
 * hostname+url tunnel, this process adopts it instead of spawning a duplicate.
 * The underlying cloudflared process stays up until the last consumer stops
 * (or dies), and is automatically respawned if it crashes.
 *
 * @param {object} [options]
 * @param {Array}  [options.tunnels]        inline config, skips config-file lookup
 * @param {string} [options.cwd]            directory to search for a config file
 * @param {string} [options.cloudflaredPath] path to cloudflared binary
 * @param {number} [options.heartbeatMs]    health-check interval (default 5000)
 * @param {number} [options.readyTimeoutMs] wait for the local port (default 15000, 0 to skip)
 * @param {string} [options.stateDir]       override shared state directory
 * @returns {Promise<{tunnels: Tunnel[], stop: () => Promise<void>}>}
 */
async function startTunnels(options = {}) {
  const config = options.tunnels
    ? { tunnels: options.tunnels }
    : loadConfig(options.cwd || process.cwd());

  const tunnels = [];
  try {
    for (const tunnelConfig of config.tunnels) {
      tunnels.push(await new Tunnel(tunnelConfig, options).start());
    }
  } catch (err) {
    await Promise.all(tunnels.map((t) => t.stop().catch(() => {})));
    throw err;
  }

  return {
    tunnels,
    async stop() {
      await Promise.all(tunnels.map((t) => t.stop()));
    },
  };
}

module.exports = { startTunnels, Tunnel, loadConfig, stateRoot };
