// Estes testes so rodam com TimescaleDB de verdade (CI usa a imagem oficial: TIMESCALE=1).
// Localmente, com o PostgreSQL embutido, ficam como "skipped".
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comTransacao, criarDispositivo, criarLocal, criarUsuario, todas, um } from './_helpers.mjs';

const exigeTimescale = process.env.TIMESCALE === '1' ? {} : { skip: 'defina TIMESCALE=1 com um banco TimescaleDB' };

describe('TimescaleDB', exigeTimescale, () => {
  it('leitura_sensor e hypertable particionada por medido_em, em chunks de 7 dias', () =>
    comTransacao(async (c) => {
      const h = await um(c, `SELECT * FROM timescaledb_information.hypertables WHERE hypertable_schema = 'refined' AND hypertable_name = 'leitura_sensor'`);
      assert.ok(h, 'hypertable nao encontrada');
      assert.equal(h.compression_enabled, true);
      const dim = await um(c, `SELECT column_name, time_interval::text AS intervalo FROM timescaledb_information.dimensions WHERE hypertable_name = 'leitura_sensor'`);
      assert.equal(dim.column_name, 'medido_em');
      assert.match(dim.intervalo, /7 days/);
    }));

  it('politicas de compressao e retencao estao ativas', () =>
    comTransacao(async (c) => {
      const jobs = await todas(c, `SELECT proc_name, config FROM timescaledb_information.jobs WHERE hypertable_name = 'leitura_sensor' ORDER BY proc_name`);
      assert.deepEqual(jobs.map((j) => j.proc_name), ['policy_compression', 'policy_retention']);
      assert.equal(jobs.find((j) => j.proc_name === 'policy_retention').config.drop_after, '24 mons');
    }));

  it('o esquema continua funcionando sobre a hypertable: PK composta, dedupe e FK', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      const ins = () => c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, pm25_microg_m3, origem_dado) VALUES ($1,'2026-05-01T10:00:00Z',10,'wifi') ON CONFLICT (dispositivo_id, medido_em) DO NOTHING`, [d.id]);
      await ins();
      await ins();
      const n = await um(c, `SELECT count(*)::int AS n FROM refined.leitura_sensor WHERE dispositivo_id = $1`, [d.id]);
      assert.equal(n.n, 1);
      const chunks = await um(c, `SELECT count(*)::int AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'leitura_sensor'`);
      assert.ok(chunks.n >= 1, 'a insercao criou um chunk');
    }));
});
