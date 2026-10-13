// Testes de integração da API contra um PostgreSQL real e descartável (sem Docker).
// Sobe o banco, aplica as migrations, cria o papel de login da API (igual ao de produção) e roda os testes.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { migrar, raiz, subirBanco } from '../database/scripts/ambiente.mjs';

const pasta = path.join(raiz, 'tests');
const arquivos = readdirSync(pasta)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => path.join(pasta, f));

const banco = await subirBanco({ porta: 54331 });
let codigo = 1;
try {
  await migrar(banco.url, 'up');

  // O papel de login da API não tem privilégio próprio (NOINHERIT): cada transação assume
  // clean_air_auth ou clean_air_app com SET LOCAL ROLE. É o mesmo arranjo a ser feito na nuvem.
  const admin = new pg.Client({ connectionString: banco.url });
  await admin.connect();
  await admin.query(
    `CREATE ROLE clean_air_api LOGIN PASSWORD 'api-teste' NOINHERIT IN ROLE clean_air_auth, clean_air_app`,
  );
  await admin.end();
  const urlApi = banco.url.replace('postgres:postgres@', 'clean_air_api:api-teste@');

  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', ...(process.argv.slice(2).length ? process.argv.slice(2) : arquivos)],
    { stdio: 'inherit', env: { ...process.env, ADMIN_DATABASE_URL: banco.url, API_DATABASE_URL: urlApi } },
  );
  codigo = r.status ?? 1;
} catch (erro) {
  console.error('Falha ao rodar os testes da API:', erro.message);
} finally {
  await banco.parar();
}
process.exit(codigo);
