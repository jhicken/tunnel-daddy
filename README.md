# tunnel-daddy

Shared, self-healing [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) TCP tunnels for Node services.

`tunnel-daddy` runs commands like:

```sh
cloudflared access tcp --hostname mongo.example.com --url localhost:37017
```

…as a managed child process, coordinated **machine-wide across multiple projects**:

- **Shared** — the first project to start spawns `cloudflared`; any other project configured with the same `hostname` + `url` adopts the running tunnel instead of starting a duplicate.
- **Persistent** — the tunnel stays up as long as *any* consumer is running. When the last consumer shuts down (cleanly or via a crash detected by heartbeats), the tunnel is closed.
- **Self-healing** — if `cloudflared` crashes or is killed, the next heartbeat respawns it, so the tunnel reconnects for as long as consumers are alive.
- **Multiple tunnels** — configure as many as you need (MongoDB, MySQL, …); each is tracked independently.

Zero dependencies. Requires the `cloudflared` binary on `PATH` (or point `cloudflaredPath` / `TUNNEL_DADDY_CLOUDFLARED` at it).

## Install

Directly from this repository:

```sh
npm install github:jhicken/tunnel-daddy
# or a specific ref
npm install github:jhicken/tunnel-daddy#v1.0.0
```

(Local development: `npm install ../tunnel-daddy`.)

## Configure

Add `tunnel-daddy.config.json` to each project's root (or a `tunnelDaddy` key in `package.json`, or `.tunnel-daddy.json`):

```json
{
  "tunnels": [
    { "name": "mongo", "hostname": "mongo.example.com", "url": "localhost:37017" },
    { "name": "mysql", "hostname": "mysql.example.com", "url": "localhost:33306" }
  ]
}
```

## Use

Start the tunnels when your service boots, before connecting to the database:

```js
const { startTunnels } = require('tunnel-daddy');

async function main() {
  // resolves once each tunnel's local port is accepting connections
  const tunnels = await startTunnels();

  // ... connect to mongodb://localhost:37017 as usual ...

  // optional on graceful shutdown (process exit is handled automatically):
  // await tunnels.stop();
}

main();
```

Inline config is also supported, skipping the config file:

```js
await startTunnels({
  tunnels: [{ hostname: 'mongo.example.com', url: 'localhost:37017' }],
});
```

### Options

| Option | Default | Description |
| --- | --- | --- |
| `tunnels` | — | Inline tunnel config; skips config-file lookup |
| `cwd` | `process.cwd()` | Directory to search for a config file |
| `cloudflaredPath` | `cloudflared` | Path to the binary (env: `TUNNEL_DADDY_CLOUDFLARED`) |
| `heartbeatMs` | `5000` | Health-check / reconnect interval |
| `readyTimeoutMs` | `15000` | How long to wait for the local port to accept connections (`0` to skip) |
| `stateDir` | `~/.tunnel-daddy` | Shared coordination directory (env: `TUNNEL_DADDY_HOME`) |

## CLI

```sh
npx tunnel-daddy run     # hold this project's tunnels open in the foreground
npx tunnel-daddy status  # list tunnels known on this machine
```

## How sharing works

Coordination lives in `~/.tunnel-daddy/tunnels/<hash>/`:

- `state.json` — the running `cloudflared` pid for a given `hostname` + `url`.
- `leases/` — one file per active consumer process. A consumer's heartbeat refreshes its lease, reaps leases of dead processes, and respawns `cloudflared` if it died.
- When the last live lease disappears, `cloudflared` is terminated and the state is removed.
- A `lock` directory (atomic `mkdir`) serializes spawn/teardown across processes.
- `cloudflared.log` — stdout/stderr of the most recent `cloudflared` process, for debugging.

## Tests

```sh
npm test
```

The suite uses a fake `cloudflared` stand-in (`test/fake-cloudflared.js`) that listens on the configured port, so no real Cloudflare access is needed.
