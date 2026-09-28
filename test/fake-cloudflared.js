#!/usr/bin/env node
'use strict';

// Stand-in for the real cloudflared binary. Parses `--url host:port` from the
// argv tunnel-daddy passes, listens on that port, and stays alive until killed.

const net = require('net');

const urlIdx = process.argv.indexOf('--url');
if (urlIdx === -1 || !process.argv[urlIdx + 1]) {
  console.error('fake-cloudflared: missing --url');
  process.exit(1);
}
const url = process.argv[urlIdx + 1];
const idx = url.lastIndexOf(':');
const host = url.slice(0, idx);
const port = Number(url.slice(idx + 1));

const server = net.createServer((socket) => socket.end());
server.listen(port, host, () => {
  console.log(`fake-cloudflared listening on ${host}:${port} (pid ${process.pid})`);
});
server.on('error', (err) => {
  console.error(`fake-cloudflared: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
