#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { startTunnels, stateRoot } = require('../lib/index');

const command = process.argv[2] || 'run';

function status() {
  const root = path.join(stateRoot(), 'tunnels');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    console.log('No tunnels have been started on this machine.');
    return;
  }
  for (const key of dirs) {
    const dir = path.join(root, key);
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    } catch {}
    if (!state) continue;
    let alive = false;
    try {
      process.kill(state.cloudflaredPid, 0);
      alive = true;
    } catch {}
    let consumers = 0;
    try {
      consumers = fs
        .readdirSync(path.join(dir, 'leases'))
        .filter((f) => f.endsWith('.json')).length;
    } catch {}
    console.log(
      `${alive ? 'UP  ' : 'DOWN'} ${state.hostname} -> ${state.url} ` +
        `(cloudflared pid ${state.cloudflaredPid}, ${consumers} consumer lease(s))`
    );
  }
}

async function run() {
  const handle = await startTunnels();
  for (const tunnel of handle.tunnels) {
    console.log(
      `tunnel open: ${tunnel.config.hostname} -> ${tunnel.config.url} ` +
        `(cloudflared pid ${tunnel.state.cloudflaredPid})`
    );
  }
  console.log('Holding tunnels open. Ctrl+C to release.');
}

if (command === 'run') {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
} else if (command === 'status') {
  status();
} else {
  console.error('Usage: tunnel-daddy [run|status]');
  process.exit(1);
}
