'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const { startTunnels, loadConfig } = require('../lib/index');
const { processAlive, waitForPort } = require('../lib/tunnel');

const FAKE_CLOUDFLARED = path.join(__dirname, 'fake-cloudflared.js');
const TUNNEL = { name: 'mongo', hostname: 'mongo.example.com', url: '127.0.0.1:37017' };

let stateDir;
let handles;

function options(extra = {}) {
  return {
    tunnels: [TUNNEL],
    cloudflaredPath: FAKE_CLOUDFLARED,
    stateDir,
    heartbeatMs: 200,
    ...extra,
  };
}

function portOpen(url) {
  const idx = url.lastIndexOf(':');
  return new Promise((resolve) => {
    const socket = net.connect(Number(url.slice(idx + 1)), url.slice(0, idx));
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function stateFile(tunnel = TUNNEL) {
  const key = crypto
    .createHash('sha1')
    .update(`${tunnel.hostname}|${tunnel.url}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(stateDir, 'tunnels', key, 'state.json');
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-daddy-test-'));
  handles = [];
});

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.stop().catch(() => {});
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('starts a tunnel and the port accepts connections', async () => {
  const handle = await startTunnels(options());
  handles.push(handle);

  assert.equal(handle.tunnels.length, 1);
  assert.ok(processAlive(handle.tunnels[0].state.cloudflaredPid));
  assert.ok(await portOpen(TUNNEL.url));
  assert.ok(fs.existsSync(stateFile()));
});

test('a second consumer adopts the existing tunnel instead of spawning a duplicate', async () => {
  const first = await startTunnels(options());
  const second = await startTunnels(options());
  handles.push(first, second);

  assert.equal(
    first.tunnels[0].state.cloudflaredPid,
    second.tunnels[0].state.cloudflaredPid
  );

  // first consumer leaving must not kill the shared tunnel
  await first.stop();
  handles.splice(handles.indexOf(first), 1);
  assert.ok(processAlive(second.tunnels[0].state.cloudflaredPid));
  assert.ok(await portOpen(TUNNEL.url));

  // last consumer stopping tears the tunnel down
  await second.stop();
  handles.splice(handles.indexOf(second), 1);
  assert.ok(!fs.existsSync(stateFile()));
  assert.ok(!(await portOpen(TUNNEL.url)));
});

test('respawns cloudflared when the process dies', async () => {
  const handle = await startTunnels(options());
  handles.push(handle);

  const originalPid = handle.tunnels[0].state.cloudflaredPid;
  process.kill(originalPid, 'SIGKILL');

  // wait past a few heartbeat intervals
  const deadline = Date.now() + 5000;
  let newState = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      newState = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch {}
    if (newState && newState.cloudflaredPid !== originalPid && processAlive(newState.cloudflaredPid)) {
      break;
    }
  }

  assert.ok(newState, 'state file should be rewritten');
  assert.notEqual(newState.cloudflaredPid, originalPid);
  assert.ok(await waitForPort(TUNNEL.url, 3000).then(() => true, () => false));
});

test('loads config from tunnel-daddy.config.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-daddy-config-'));
  fs.writeFileSync(
    path.join(dir, 'tunnel-daddy.config.json'),
    JSON.stringify({ tunnels: [TUNNEL, { name: 'mysql', hostname: 'mysql.example.com', url: '127.0.0.1:33306' }] })
  );
  const config = loadConfig(dir);
  assert.equal(config.tunnels.length, 2);
  assert.equal(config.tunnels[1].hostname, 'mysql.example.com');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loads config from package.json tunnelDaddy key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-daddy-config-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'demo', tunnelDaddy: { tunnels: [TUNNEL] } })
  );
  const config = loadConfig(dir);
  assert.equal(config.tunnels[0].hostname, TUNNEL.hostname);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two separate processes share one tunnel; last one out tears it down', { timeout: 30000 }, async () => {
  const { spawn } = require('child_process');

  const consumerSrc = `
    const { startTunnels } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'index.js'))});
    startTunnels({
      tunnels: [${JSON.stringify(TUNNEL)}],
      cloudflaredPath: ${JSON.stringify(FAKE_CLOUDFLARED)},
      stateDir: ${JSON.stringify(stateDir)},
      heartbeatMs: 200,
    }).then((h) => {
      console.log('adopted:' + h.tunnels[0].state.cloudflaredPid);
      setInterval(() => {}, 1000);
    });
  `;

  const spawnConsumer = () => {
    const child = spawn('node', ['-e', consumerSrc], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.adopted = new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        const match = String(chunk).match(/adopted:(\d+)/);
        if (match) resolve(Number(match[1]));
      });
    });
    return child;
  };

  const c1 = spawnConsumer();
  const c2 = spawnConsumer();
  const [pid1, pid2] = await Promise.all([c1.adopted, c2.adopted]);
  assert.equal(pid1, pid2, 'both processes should adopt the same cloudflared');

  c1.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(processAlive(pid2), 'tunnel must survive first consumer exiting');

  c2.kill('SIGTERM');
  let stateGone = false;
  const teardownDeadline = Date.now() + 8000;
  while (Date.now() < teardownDeadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (!fs.existsSync(stateFile())) {
      stateGone = true;
      break;
    }
  }
  assert.ok(stateGone, 'state file removed after last consumer exits');
  assert.ok(!processAlive(pid2), 'cloudflared killed after last consumer exits');
  assert.ok(!(await portOpen(TUNNEL.url)));
});

test('supports multiple tunnels in one project', async () => {
  const mysql = { name: 'mysql', hostname: 'mysql.example.com', url: '127.0.0.1:43306' };
  const handle = await startTunnels(options({ tunnels: [TUNNEL, mysql] }));
  handles.push(handle);

  assert.equal(handle.tunnels.length, 2);
  assert.ok(await portOpen(TUNNEL.url));
  assert.ok(await portOpen(mysql.url));
  assert.notEqual(
    handle.tunnels[0].state.cloudflaredPid,
    handle.tunnels[1].state.cloudflaredPid
  );
});
