'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_READY_TIMEOUT_MS = 15000;
const LOCK_TIMEOUT_MS = 10000;

function stateRoot() {
  return process.env.TUNNEL_DADDY_HOME || path.join(os.homedir(), '.tunnel-daddy');
}

/**
 * Resolve the cloudflared executable, in priority order:
 *   1. explicit `cloudflaredPath` option
 *   2. TUNNEL_DADDY_CLOUDFLARED env var
 *   3. the binary bundled with the npm `cloudflared` dependency
 *   4. `cloudflared` on PATH
 */
function resolveCloudflaredPath(option) {
  if (option) return option;
  if (process.env.TUNNEL_DADDY_CLOUDFLARED) return process.env.TUNNEL_DADDY_CLOUDFLARED;
  try {
    return require('cloudflared').bin;
  } catch {
    return 'cloudflared';
  }
}

function tunnelKey(config) {
  return crypto
    .createHash('sha1')
    .update(`${config.hostname}|${config.url}`)
    .digest('hex')
    .slice(0, 16);
}

function processAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUrl(url) {
  const idx = url.lastIndexOf(':');
  if (idx === -1) throw new Error(`tunnel-daddy: url "${url}" must be host:port`);
  return { host: url.slice(0, idx), port: Number(url.slice(idx + 1)) };
}

function waitForPort(url, timeoutMs) {
  const { host, port } = parseUrl(url);
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, host);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`tunnel-daddy: timed out waiting for ${url} to accept connections`));
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

/**
 * mkdir-based mutex shared across processes. The lock holder's pid is stored
 * inside so dead holders can be broken by the next contender.
 */
async function withLock(dir, fn) {
  const lockDir = path.join(dir, 'lock');
  const pidFile = path.join(lockDir, 'pid');
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, String(process.pid));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let holder = NaN;
      try {
        holder = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      } catch {
        // lock dir exists but pid not written yet; retry
      }
      if (!Number.isNaN(holder) && !processAlive(holder)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        // holder wedged; break the lock rather than block forever
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      await sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function withLockSync(dir, fn) {
  const lockDir = path.join(dir, 'lock');
  const pidFile = path.join(lockDir, 'pid');
  for (let i = 0; i < 40; i++) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(pidFile, String(process.pid));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        const holder = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
        if (!processAlive(holder)) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
      // busy-wait briefly (sync context: process exit handler)
      const until = Date.now() + 25;
      while (Date.now() < until);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * One shared cloudflared tunnel, coordinated across processes via files in
 * <stateRoot>/tunnels/<key>/:
 *   state.json       { hostname, url, cloudflaredPid, ownerPid, startedAt }
 *   leases/<id>.json one per active consumer ({ pid, name, cwd, updatedAt })
 *   cloudflared.log  stdout/stderr of the cloudflared child
 */
class Tunnel {
  constructor(config, options = {}) {
    this.config = config;
    this.key = tunnelKey(config);
    this.dir = path.join(options.stateDir || stateRoot(), 'tunnels', this.key);
    this.leasesDir = path.join(this.dir, 'leases');
    this.stateFile = path.join(this.dir, 'state.json');
    this.logFile = path.join(this.dir, 'cloudflared.log');
    this.cloudflaredPath = resolveCloudflaredPath(options.cloudflaredPath);
    this.heartbeatMs = options.heartbeatMs || DEFAULT_HEARTBEAT_MS;
    this.readyTimeoutMs =
      options.readyTimeoutMs === undefined ? DEFAULT_READY_TIMEOUT_MS : options.readyTimeoutMs;
    this.leaseId = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    this.stopped = false;
    this.timer = null;
    this._exitHook = null;
    this._signalHandlers = [];
  }

  async start() {
    fs.mkdirSync(this.leasesDir, { recursive: true });

    await withLock(this.dir, () => this._ensureRunningLocked());
    this._writeLease();

    if (this.readyTimeoutMs > 0) {
      await waitForPort(this.config.url, this.readyTimeoutMs);
    }

    this.timer = setInterval(() => {
      this._tick().catch(() => {});
    }, this.heartbeatMs);
    this.timer.unref();

    this._exitHook = () => this._stopSync();
    process.once('exit', this._exitHook);
    for (const sig of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        this._stopSync();
        process.kill(process.pid, sig);
      };
      process.once(sig, handler);
      this._signalHandlers.push([sig, handler]);
    }

    return this;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this._removeHooks();
    await withLock(this.dir, () => {
      this._removeLease();
      this._reapDeadLeases();
      if (this._liveLeases().length === 0) this._teardownLocked();
    });
  }

  // --- internals ---

  async _tick() {
    if (this.stopped) return;
    this._writeLease();
    await withLock(this.dir, () => {
      this._reapDeadLeases();
      this._ensureRunningLocked();
    });
  }

  _ensureRunningLocked() {
    const state = this._readState();
    if (state && processAlive(state.cloudflaredPid)) {
      this.state = state;
      return;
    }
    if (state && state.cloudflaredPid) {
      try {
        process.kill(state.cloudflaredPid, 'SIGKILL');
      } catch {}
    }
    this._spawnLocked();
  }

  _spawnLocked() {
    const logFd = fs.openSync(this.logFile, 'a');
    const child = spawn(
      this.cloudflaredPath,
      ['access', 'tcp', '--hostname', this.config.hostname, '--url', this.config.url],
      { detached: true, stdio: ['ignore', logFd, logFd] }
    );
    fs.closeSync(logFd);
    child.unref();
    child.on('error', () => {});

    this.state = {
      hostname: this.config.hostname,
      url: this.config.url,
      cloudflaredPid: child.pid,
      ownerPid: process.pid,
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  _readState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  _writeLease() {
    const lease = {
      pid: process.pid,
      name: this.config.name || this.config.hostname,
      cwd: process.cwd(),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.leasesDir, `${this.leaseId}.json`), JSON.stringify(lease));
  }

  _removeLease() {
    fs.rmSync(path.join(this.leasesDir, `${this.leaseId}.json`), { force: true });
  }

  _leaseFiles() {
    try {
      return fs.readdirSync(this.leasesDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }

  _reapDeadLeases() {
    for (const file of this._leaseFiles()) {
      try {
        const lease = JSON.parse(fs.readFileSync(path.join(this.leasesDir, file), 'utf8'));
        if (!processAlive(lease.pid)) {
          fs.rmSync(path.join(this.leasesDir, file), { force: true });
        }
      } catch {
        fs.rmSync(path.join(this.leasesDir, file), { force: true });
      }
    }
  }

  _liveLeases() {
    return this._leaseFiles()
      .map((file) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(this.leasesDir, file), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter((lease) => lease && processAlive(lease.pid));
  }

  _teardownLocked() {
    const state = this._readState();
    if (state && state.cloudflaredPid) {
      try {
        process.kill(state.cloudflaredPid, 'SIGTERM');
      } catch {}
      // give it a moment, then force-kill if it survived
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && processAlive(state.cloudflaredPid)) {
        const until = Date.now() + 25;
        while (Date.now() < until);
      }
      try {
        process.kill(state.cloudflaredPid, 'SIGKILL');
      } catch {}
    }
    fs.rmSync(this.stateFile, { force: true });
    this.state = null;
  }

  _removeHooks() {
    if (this._exitHook) process.removeListener('exit', this._exitHook);
    for (const [sig, handler] of this._signalHandlers) {
      process.removeListener(sig, handler);
    }
    this._signalHandlers = [];
  }

  _stopSync() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    try {
      withLockSync(this.dir, () => {
        this._removeLease();
        this._reapDeadLeases();
        if (this._liveLeases().length === 0) this._teardownLocked();
      });
    } catch {}
  }
}

module.exports = { Tunnel, stateRoot, tunnelKey, processAlive, waitForPort, resolveCloudflaredPath };
