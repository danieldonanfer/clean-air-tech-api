// Consolida as migrations (apenas a parte "Up") em um unico schema.sql legivel, para enviar/ler.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pastaMigrations, raiz } from './ambiente.mjs';

const arquivos = readdirSync(pastaMigrations).filter((f) => f.endsWith('.sql')).sort();
const partes = arquivos.map((arquivo) => {
  const bruto = readFileSync(path.join(pastaMigrations, arquivo), 'utf8');
  const [subida] = bruto.split(/^-- Down Migration\s*$/m);
  const corpo = subida.replace(/^-- Up Migration\s*$/m, '').trim();
  return `-- =====================================================================\n-- ${arquivo}\n-- =====================================================================\n\n${corpo}\n`;
});

const cabecalho = `-- Clean Air Tech - esquema consolidado do banco de dados
-- PostgreSQL 17+ (TimescaleDB opcional: ver 0009_timescaledb_hypertable.sql)
--
-- ARQUIVO GERADO por "npm run db:schema" a partir de database/migrations/ (parte Up).
-- Para criar o banco use as migrations (npm run db:migrate); este arquivo serve para leitura e revisao.

`;

const destino = path.join(raiz, 'database', 'docs');
mkdirSync(destino, { recursive: true });
writeFileSync(path.join(destino, 'schema.sql'), cabecalho + partes.join('\n'), 'utf8');
console.log(`schema.sql gerado (${arquivos.length} migrations).`);
