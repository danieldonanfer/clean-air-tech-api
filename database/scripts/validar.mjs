// Valida o banco de ponta a ponta: migrations (up -> down -> up) e testes do esquema.
// Sem DATABASE_URL, usa um PostgreSQL embutido (sem Docker); com ela (CI), usa o banco informado.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { migrar, raiz, subirBanco } from './ambiente.mjs';

const pastaTestes = path.join(raiz, 'database', 'tests');
const arquivos = readdirSync(pastaTestes).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => path.join(pastaTestes, f));

const banco = await subirBanco();
let codigo = 1;
try {
  await migrar(banco.url, 'up');
  await migrar(banco.url, 'down');
  const aplicadas = await migrar(banco.url, 'up');
  console.log(`migrations: up -> down -> up OK (${aplicadas.length} aplicadas)\n`);

  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...arquivos], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: banco.url },
  });
  codigo = r.status ?? 1;
} catch (erro) {
  console.error('Falha ao validar o banco:', erro.message);
} finally {
  await banco.parar();
}
process.exit(codigo);
