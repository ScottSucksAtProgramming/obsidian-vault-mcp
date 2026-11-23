import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, type Config } from './config.js';
import { createHttpServer } from './http.js';
import { Ops } from './ops.js';
import { VaultPaths } from './paths.js';
import { StatusChecker, type ExecFn } from './status.js';
import { Vault } from './vault.js';
import { Writer } from './writer.js';

export function buildApp(cfg: Config, exec?: ExecFn) {
  const paths = new VaultPaths(cfg.vaultDir, cfg.readonlyDirs);
  const vault = new Vault(paths, cfg.readMaxBytes);
  const writer = new Writer(paths, cfg.writeMaxBytes);
  const ops = new Ops(vault, writer, cfg);
  const status = new StatusChecker(vault, cfg, exec);
  const server = createHttpServer(cfg, ops, status);
  return { server, ops, status, vault };
}

function main() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Configuration error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const { server, ops } = buildApp(cfg);
  server.listen(cfg.port, cfg.host, () => {
    console.log(JSON.stringify({ event: 'start', mode: cfg.accessMode, host: cfg.host, port: cfg.port }));
    // Read every note once now, so the first move or rename doesn't have to.
    if (cfg.accessMode === 'full') ops.mover.warm().catch((e) => console.error('warming the link index failed:', e));
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
