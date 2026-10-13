import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comTransacao, contar, criarDispositivo, criarLocal, criarUsuario, rejeita, todas, um } from './_helpers.mjs';

const CHECK = '23514';

describe('camada trusted (esquema estrela)', () => {
  it('calendario: gera dias, semana ISO e fim de semana, sem duplicar', () =>
    comTransacao(async (c) => {
      const n = await um(c, `SELECT trusted.carregar_dim_tempo('2026-05-01','2026-05-10') AS n`);
      assert.equal(n.n, 10);
      assert.equal((await um(c, `SELECT trusted.carregar_dim_tempo('2026-05-05','2026-05-12') AS n`)).n, 2, 'so insere os dias novos');
      const sabado = await um(c, `SELECT * FROM trusted.dim_tempo WHERE tempo_key = '2026-05-02'`);
      assert.equal(sabado.nome_dia, 'sabado');
      assert.equal(sabado.fim_de_semana, true);
      assert.equal(sabado.nome_mes, 'maio');
      assert.equal((await um(c, `SELECT * FROM trusted.dim_tempo WHERE tempo_key = '2026-05-04'`)).fim_de_semana, false);
    }));

  it('carga horaria agrega medias, maximo, contagem e alertas', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const casa = await criarLocal(c, u.id, { nome: 'Casa', tipo: 'residencia' });
      const sala = await criarLocal(c, u.id, { nome: 'Sala', paiId: casa.id });
      const d = await criarDispositivo(c, sala.id, u.id);
      const leitura = (quando, pm25, co2) =>
        c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, pm25_microg_m3, co2_ppm, origem_dado) VALUES ($1,$2,$3,$4,'wifi')`, [d.id, quando, pm25, co2]);
      await leitura('2026-05-01T10:05:00Z', 10, 500);
      await leitura('2026-05-01T10:35:00Z', 30, 700);
      await leitura('2026-05-01T10:55:00Z', 20, 600);
      await leitura('2026-05-01T11:10:00Z', 50, 900);
      await c.query(`INSERT INTO refined.alerta (dispositivo_id, usuario_id, medido_em_referencia, tipo_alerta, nivel_severidade, valor_medido, limiar_referencia) VALUES ($1,$2,'2026-05-01T11:10:00Z','pm25_alto','critico',50,35)`, [d.id, u.id]);

      await c.query(`SELECT trusted.carregar_fato_leitura('2026-05-01T00:00:00Z')`);
      const fatos = await todas(c, `SELECT * FROM trusted.fato_leitura ORDER BY hora_do_dia`);
      assert.equal(fatos.length, 2);
      assert.deepEqual(
        { h: fatos[0].hora_do_dia, med: Number(fatos[0].pm25_medio), max: Number(fatos[0].pm25_maximo), co2: Number(fatos[0].co2_medio), n: fatos[0].quantidade_leituras, a: fatos[0].quantidade_alertas },
        { h: 10, med: 20, max: 30, co2: 600, n: 3, a: 0 });
      assert.deepEqual({ h: fatos[1].hora_do_dia, n: fatos[1].quantidade_leituras, a: fatos[1].quantidade_alertas }, { h: 11, n: 1, a: 1 });

      const local = await um(c, `SELECT * FROM trusted.dim_local WHERE local_id = $1`, [sala.id]);
      assert.equal(local.nivel_hierarquia, 2, 'Sala esta um nivel abaixo de Casa');
      assert.equal(fatos[0].local_key, local.local_key);
    }));

  it('carga e idempotente: reprocessar o periodo nao duplica nem altera', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      await c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, pm25_microg_m3, origem_dado) VALUES ($1,'2026-05-01T10:05:00Z',10,'wifi')`, [d.id]);
      await c.query(`SELECT trusted.carregar_fato_leitura('2026-05-01T00:00:00Z')`);
      const antes = await todas(c, `SELECT * FROM trusted.fato_leitura`);
      await c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, pm25_microg_m3, origem_dado) VALUES ($1,'2026-05-01T10:20:00Z',30,'wifi')`, [d.id]);
      await c.query(`SELECT trusted.carregar_fato_leitura('2026-05-01T00:00:00Z')`);
      await c.query(`SELECT trusted.carregar_fato_leitura('2026-05-01T00:00:00Z')`);
      const depois = await todas(c, `SELECT * FROM trusted.fato_leitura`);
      assert.equal(antes.length, 1);
      assert.equal(depois.length, 1);
      assert.equal(Number(depois[0].pm25_medio), 20, 'dado tardio atualiza a hora ja carregada');
      assert.equal(depois[0].quantidade_leituras, 2);
    }));

  it('SCD tipo 2: cada fato aponta para a versao de firmware vigente NA HORA da leitura', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id, { serie: 'SN-SCD2' });
      await c.query(`INSERT INTO refined.firmware_versao (dispositivo_id, versao_codigo, valido_de) VALUES ($1,'1.0.0','2026-04-01T00:00:00Z')`, [d.id]);
      const leitura = (quando) => c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, pm25_microg_m3, origem_dado) VALUES ($1,$2,10,'wifi')`, [d.id, quando]);
      await leitura('2026-04-10T10:00:00Z');
      await c.query(`SELECT trusted.carregar_fato_leitura('2026-04-01T00:00:00Z')`);

      await c.query(`INSERT INTO refined.firmware_versao (dispositivo_id, versao_codigo, valido_de) VALUES ($1,'2.0.0','2026-05-01T00:00:00Z')`, [d.id]);
      await leitura('2026-05-10T10:00:00Z');
      await c.query(`SELECT trusted.carregar_fato_leitura('2026-04-01T00:00:00Z')`);

      const versoes = await todas(c, `SELECT versao_firmware, registro_atual, valido_ate FROM trusted.dim_dispositivo WHERE dispositivo_id = $1 ORDER BY valido_de`, [d.id]);
      assert.deepEqual(versoes.map((v) => [v.versao_firmware, v.registro_atual]), [['1.0.0', false], ['2.0.0', true]]);
      assert.ok(versoes[0].valido_ate, 'a versao antiga foi fechada');

      const fatos = await todas(c, `SELECT f.tempo_key::text AS dia, dd.versao_firmware FROM trusted.fato_leitura f JOIN trusted.dim_dispositivo dd USING (dispositivo_key) ORDER BY f.tempo_key`);
      assert.deepEqual(fatos.map((f) => f.versao_firmware), ['1.0.0', '2.0.0'], 'o fato de abril continua ligado ao firmware 1.0.0');
    }));

  it('dimensao de local nao carrega nome nem coordenadas', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`INSERT INTO refined.local (usuario_id, nome, tipo_local, latitude, longitude) VALUES ($1,'Casa da Maria Silva','residencia',-25.4,-49.2)`, [u.id]);
      await c.query(`SELECT trusted.carregar_dim_local()`);
      const dim = await um(c, `SELECT to_jsonb(d) AS j FROM trusted.dim_local d`);
      assert.ok(!JSON.stringify(dim.j).includes('Maria'));
      assert.ok(!('nome' in dim.j) && !('latitude' in dim.j));
    }));

  it('fato respeita dominio: hora 0-23 e ao menos uma leitura', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      await c.query(`SELECT trusted.carregar_dim_tempo('2026-05-01','2026-05-01')`);
      await c.query(`SELECT trusted.carregar_dim_local()`);
      await c.query(`SELECT trusted.carregar_dim_dispositivo()`);
      const dd = await um(c, `SELECT dispositivo_key FROM trusted.dim_dispositivo WHERE dispositivo_id = $1`, [d.id]);
      const dl = await um(c, `SELECT local_key FROM trusted.dim_local`);
      const ins = (hora, n) => c.query(`INSERT INTO trusted.fato_leitura (dispositivo_key, tempo_key, hora_do_dia, local_key, quantidade_leituras) VALUES ($1,'2026-05-01',$2,$3,$4)`, [dd.dispositivo_key, hora, dl.local_key, n]);
      await rejeita(c, `INSERT INTO trusted.fato_leitura (dispositivo_key, tempo_key, hora_do_dia, local_key, quantidade_leituras) VALUES ($1,'2026-05-01',24,$2,1)`, [dd.dispositivo_key, dl.local_key], { codigo: CHECK });
      await rejeita(c, `INSERT INTO trusted.fato_leitura (dispositivo_key, tempo_key, hora_do_dia, local_key, quantidade_leituras) VALUES ($1,'2026-05-01',3,$2,0)`, [dd.dispositivo_key, dl.local_key], { codigo: CHECK });
      await ins(3, 5);
      assert.equal(await contar(c, `SELECT count(*) AS n FROM trusted.fato_leitura`), 1);
    }));
});
