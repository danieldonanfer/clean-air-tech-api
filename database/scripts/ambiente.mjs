// Sobe um PostgreSQL real e descartavel (sem Docker) ou usa DATABASE_URL, e aplica as migrations.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { runner } from 'node-pg-migrate';

export const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const pastaMigrations = path.join(raiz, 'database', 'migrations');

export async function subirBanco({ porta = 54329 } = {}) {
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, embutido: false, parar: async () => {} };
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'clean-air-pg-'));
  const servidor = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: porta,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await servidor.initialise();
  await servidor.start();
  await servidor.createDatabase('clean_air');
  return {
    url: `postgres://postgres:postgres@localhost:${porta}/clean_air`,
    embutido: true,
    parar: async () => {
      await servidor.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function migrar(url, direcao = 'up') {
  return runner({
    databaseUrl: url,
    dir: pastaMigrations,
    direction: direcao,
    count: Infinity,
    migrationsTable: 'pgmigrations',
    log: () => {},
  });
}
