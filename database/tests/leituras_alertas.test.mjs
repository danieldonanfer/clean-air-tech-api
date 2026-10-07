import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comTransacao, contar, criarDispositivo, criarLocal, criarUsuario, rejeita, todas, um } from './_helpers.mjs';

const CHECK = '23514';
const UNICO = '23505';

async function cenario(c) {
  const u = await criarUsuario(c);
  const l = await criarLocal(c, u.id);
  const d = await criarDispositivo(c, l.id, u.id, { serie: 'SN-LEITURA' });
  return { u, l, d };
}

describe('leitura_sensor', () => {
  it('guarda as 13 grandezas e rejeita valores fisicamente impossiveis', () =>
    comTransacao(async (c) => {
      const { d } = await cenario(c);
      await c.query(
        `INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, pm1_microg_m3, pm25_microg_m3, pm10_microg_m3, no2_ppm,
           tvoc_indice, co2_ppm, co_ppm, o3_ppm, temperatura_celsius, umidade_percentual, pressao_hpa, indice_uv, origem_dado)
         VALUES ($1, now(), 5, 12.5, 20, 0.021, 80, 612, 0.9, 0.031, 23.4, 55, 1013.2, 3.5, 'wifi')`, [d.id]);
      const ruins = [
        ['umidade_percentual', 101], ['umidade_percentual', -1], ['pressao_hpa', 200], ['pressao_hpa', 1200],
        ['pm25_microg_m3', -1], ['indice_uv', 25], ['temperatura_celsius', 150], ['co2_ppm', -10],
      ];
      for (const [coluna, valor] of ruins) {
        await rejeita(c, `INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, ${coluna}, origem_dado) VALUES ($1, now() + interval '1 hour', $2, 'wifi')`, [d.id, valor], { codigo: CHECK });
      }
    }));

  it('origem do dado limitada aos quatro meios de conectividade', () =>
    comTransacao(async (c) => {
      const { d } = await cenario(c);
      for (const [i, origem] of ['wifi', 'bluetooth', 'lora', 'gsm'].entries()) {
        await c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, origem_dado) VALUES ($1, now() + ($2 || ' seconds')::interval, $3)`, [d.id, i, origem]);
      }
      await rejeita(c, `INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, origem_dado) VALUES ($1, now() + interval '1 day', 'zigbee')`, [d.id], { codigo: CHECK });
    }));

  it('um dispositivo nao tem duas leituras no mesmo instante', () =>
    comTransacao(async (c) => {
      const { d } = await cenario(c);
      await c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, origem_dado) VALUES ($1, '2026-05-01 10:00:00+00', 'wifi')`, [d.id]);
      await rejeita(c, `INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, origem_dado) VALUES ($1, '2026-05-01 10:00:00+00', 'wifi')`, [d.id], { codigo: UNICO });
    }));
});

describe('carga raw -> refined', () => {
  it('carrega, deduplica e rejeita sem derrubar o lote', () =>
    comTransacao(async (c) => {
      const { d } = await cenario(c);
      const lote = await um(c, `INSERT INTO raw.lote_ingestao (origem, sincronizacao_offline, quantidade_registros) VALUES ('lora', true, 5) RETURNING id`);
      const bruta = (serie, quando, payload) =>
        c.query(`INSERT INTO raw.leitura_bruta (lote_ingestao_id, numero_serie, medido_em, payload) VALUES ($1,$2,$3,$4)`, [lote.id, serie, quando, JSON.stringify(payload)]);

      await bruta('SN-LEITURA', '2026-05-01T10:00:00Z', { pm25_microg_m3: 12.5, co2_ppm: 600 });
      await bruta('SN-LEITURA', '2026-05-01T10:00:00Z', { pm25_microg_m3: 99 });
      await bruta('SN-FANTASMA', '2026-05-01T10:01:00Z', { pm25_microg_m3: 10 });
      await bruta('SN-LEITURA', '2026-05-01T10:02:00Z', { umidade_percentual: 150 });
      await bruta('SN-LEITURA', '2026-05-01T10:03:00Z', { pm25_microg_m3: 'abc' });

      const r = await um(c, `SELECT * FROM refined.carregar_leituras_do_raw()`);
      assert.deepEqual({ ins: r.inseridas, dup: r.duplicadas, rej: r.rejeitadas }, { ins: 1, dup: 1, rej: 3 });

      const gravada = await um(c, `SELECT * FROM refined.leitura_sensor WHERE dispositivo_id = $1`, [d.id]);
      assert.equal(Number(gravada.pm25_microg_m3), 12.5, 'a primeira leitura prevalece sobre a duplicada');
      assert.equal(gravada.origem_dado, 'lora', 'sem origem no payload, usa a origem do lote');
      assert.equal(gravada.lote_ingestao_id, lote.id);

      const erros = await todas(c, `SELECT numero_serie, erro FROM raw.leitura_bruta WHERE erro IS NOT NULL ORDER BY id`);
      assert.equal(erros.length, 3);
      assert.equal(erros[0].erro, 'dispositivo_desconhecido');
      assert.equal(await contar(c, `SELECT count(*) AS n FROM raw.leitura_bruta WHERE processado_em IS NULL`), 0);

      const segunda = await um(c, `SELECT * FROM refined.carregar_leituras_do_raw()`);
      assert.deepEqual({ i: segunda.inseridas, d: segunda.duplicadas, r: segunda.rejeitadas }, { i: 0, d: 0, r: 0 }, 'idempotente: nada pendente');
    }));

  it('expurgo apaga so o que ja foi processado e e antigo', () =>
    comTransacao(async (c) => {
      const lote = await um(c, `INSERT INTO raw.lote_ingestao (origem, recebido_em) VALUES ('wifi', now() - interval '30 days') RETURNING id`);
      const ins = (proc) => c.query(`INSERT INTO raw.leitura_bruta (lote_ingestao_id, numero_serie, medido_em, payload, processado_em) VALUES ($1,'S',now(),'{}',$2)`, [lote.id, proc]);
      await ins(new Date(Date.now() - 20 * 86400e3));
      await ins(new Date(Date.now() - 1 * 86400e3));
      await ins(null);
      const apagadas = await um(c, `SELECT raw.expurgar_processados(7) AS n`);
      assert.equal(apagadas.n, 1);
      assert.equal(await contar(c, `SELECT count(*) AS n FROM raw.leitura_bruta`), 2);
    }));
});

describe('alertas e recomendacoes', () => {
  async function alerta(c, { u, d }, extra = {}) {
    return um(c,
      `INSERT INTO refined.alerta (dispositivo_id, usuario_id, medido_em_referencia, tipo_alerta, nivel_severidade, valor_medido, limiar_referencia)
       VALUES ($1,$2, now(), $3, 'atencao', 80.5, 35) RETURNING *`, [d.id, u.id, extra.tipo ?? 'pm25_alto']);
  }

  it('mudanca de status guarda o anterior e o instante', () =>
    comTransacao(async (c) => {
      const cen = await cenario(c);
      const a = await alerta(c, cen);
      assert.equal(a.status_principal, 'aberto');
      assert.equal(a.status_anterior, null);
      const b = await um(c, `UPDATE refined.alerta SET status_principal = 'reconhecido' WHERE id = $1 RETURNING *`, [a.id]);
      assert.equal(b.status_anterior, 'aberto');
      assert.ok(b.status_alterado_em);
      const igual = await um(c, `UPDATE refined.alerta SET status_principal = 'reconhecido' WHERE id = $1 RETURNING *`, [a.id]);
      assert.equal(igual.status_anterior, 'aberto', 'reaplicar o mesmo status nao apaga o historico');
      await rejeita(c, `UPDATE refined.alerta SET status_principal = 'sumiu' WHERE id = $1`, [a.id], { codigo: CHECK });
    }));

  it('cobre todas as grandezas monitoradas', () =>
    comTransacao(async (c) => {
      const cen = await cenario(c);
      for (const tipo of ['pm25_alto', 'pm10_alto', 'co2_alto', 'co_alto', 'o3_alto', 'no2_alto', 'tvoc_alto', 'uv_alto', 'temperatura_fora_faixa', 'umidade_fora_faixa']) {
        await alerta(c, cen, { tipo });
      }
      await rejeita(c, `INSERT INTO refined.alerta (dispositivo_id, usuario_id, medido_em_referencia, tipo_alerta, nivel_severidade, valor_medido, limiar_referencia) VALUES ($1,$2,now(),'radiacao','info',1,1)`, [cen.d.id, cen.u.id], { codigo: CHECK });
    }));

  it('recomendacao por modelo preditivo exige a versao do modelo; por regra fixa nao pode ter', () =>
    comTransacao(async (c) => {
      const cen = await cenario(c);
      const a = await alerta(c, cen);
      const m = await um(c, `INSERT INTO refined.modelo_ia_versao (nome_modelo, versao_codigo) VALUES ('recomendacao_qualidade_ar','1.0') RETURNING id`);
      const ins = (fonte, modelo) => c.query(`INSERT INTO refined.recomendacao (alerta_id, texto_recomendacao, categoria_acao, fonte_geracao, modelo_ia_versao_id) VALUES ($1,'Abra a janela','ventilacao',$2,$3)`, [a.id, fonte, modelo]);
      await ins('regra_fixa', null);
      await ins('modelo_preditivo', m.id);
      await rejeita(c, `INSERT INTO refined.recomendacao (alerta_id, texto_recomendacao, categoria_acao, fonte_geracao) VALUES ($1,'x','outro','modelo_preditivo')`, [a.id], { codigo: CHECK });
      await rejeita(c, `INSERT INTO refined.recomendacao (alerta_id, texto_recomendacao, categoria_acao, fonte_geracao, modelo_ia_versao_id) VALUES ($1,'x','outro','regra_fixa',$2)`, [a.id, m.id], { codigo: CHECK });
    }));

  it('notificacao: uma por alerta, usuario e canal; silencio exige inicio e fim', () =>
    comTransacao(async (c) => {
      const cen = await cenario(c);
      const a = await alerta(c, cen);
      await c.query(`INSERT INTO refined.notificacao_enviada (usuario_id, alerta_id, canal_envio) VALUES ($1,$2,'push')`, [cen.u.id, a.id]);
      await rejeita(c, `INSERT INTO refined.notificacao_enviada (usuario_id, alerta_id, canal_envio) VALUES ($1,$2,'push')`, [cen.u.id, a.id], { codigo: UNICO });
      await c.query(`INSERT INTO refined.notificacao_enviada (usuario_id, alerta_id, canal_envio) VALUES ($1,$2,'email')`, [cen.u.id, a.id]);
      await rejeita(c, `INSERT INTO refined.preferencia_notificacao (usuario_id, tipo_alerta, canal, horario_silencio_inicio) VALUES ($1,'pm25_alto','push','22:00')`, [cen.u.id], { codigo: CHECK });
      await c.query(`INSERT INTO refined.preferencia_notificacao (usuario_id, tipo_alerta, canal, horario_silencio_inicio, horario_silencio_fim) VALUES ($1,'pm25_alto','push','22:00','07:00')`, [cen.u.id]);
    }));

  it('evento sonoro registra categoria, confianca e o modelo que classificou', () =>
    comTransacao(async (c) => {
      const cen = await cenario(c);
      const m = await um(c, `INSERT INTO refined.modelo_ia_versao (nome_modelo, versao_codigo) VALUES ('classificador_evento_sonoro','0.1') RETURNING id`);
      const ins = (cat, conf) => c.query(`INSERT INTO refined.evento_sonoro_detectado (dispositivo_id, detectado_em, categoria_evento, confianca_classificacao, modelo_ia_versao_id) VALUES ($1, now(), $2, $3, $4)`, [cen.d.id, cat, conf, m.id]);
      for (const cat of ['cozinha', 'aspirador', 'chuva', 'trovao', 'outro']) await ins(cat, 0.9);
      await rejeita(c, `INSERT INTO refined.evento_sonoro_detectado (dispositivo_id, detectado_em, categoria_evento, confianca_classificacao, modelo_ia_versao_id) VALUES ($1, now(), 'cozinha', 1.5, $2)`, [cen.d.id, m.id], { codigo: CHECK });
      await rejeita(c, `INSERT INTO refined.evento_sonoro_detectado (dispositivo_id, detectado_em, categoria_evento, confianca_classificacao, modelo_ia_versao_id) VALUES ($1, now(), 'tiro', 0.5, $2)`, [cen.d.id, m.id], { codigo: CHECK });
    }));
});

describe('negocio, suporte e LGPD', () => {
  it('uma assinatura vigente por usuario; a anterior fica no historico', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`INSERT INTO refined.assinatura_plano (usuario_id, nivel_plano) VALUES ($1,'gratuito')`, [u.id]);
      await rejeita(c, `INSERT INTO refined.assinatura_plano (usuario_id, nivel_plano) VALUES ($1,'pro')`, [u.id], { codigo: UNICO });
      await c.query(`UPDATE refined.assinatura_plano SET data_fim = current_date WHERE usuario_id = $1`, [u.id]);
      await c.query(`INSERT INTO refined.assinatura_plano (usuario_id, nivel_plano, limite_dispositivos) VALUES ($1,'pro',10)`, [u.id]);
      assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.assinatura_plano WHERE usuario_id = $1`, [u.id]), 2);
    }));

  it('saude da conta guarda historico e a view devolve o calculo mais recente', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`INSERT INTO refined.saude_conta (usuario_id, pontuacao_saude, risco_cancelamento, calculado_em) VALUES ($1, 80,'baixo','2026-01-01'), ($1, 35,'alto','2026-02-01')`, [u.id]);
      const atual = await um(c, `SELECT * FROM refined.v_saude_conta_atual WHERE usuario_id = $1`, [u.id]);
      assert.equal(Number(atual.pontuacao_saude), 35);
      assert.equal(atual.risco_cancelamento, 'alto');
      await rejeita(c, `INSERT INTO refined.saude_conta (usuario_id, pontuacao_saude, risco_cancelamento) VALUES ($1, 101,'baixo')`, [u.id], { codigo: CHECK });
    }));

  it('ticket nasce com SLA de 24 h e marca violacao quando o prazo ja passou', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const t = await um(c, `INSERT INTO refined.ticket_suporte (usuario_id, assunto, categoria_atendimento) VALUES ($1,'Sensor offline','tecnico') RETURNING *`, [u.id]);
      const horas = (new Date(t.sla_limite_em) - new Date(t.criado_em)) / 3600e3;
      assert.ok(Math.abs(horas - 24) < 0.01);
      assert.equal(t.sla_violado, false);
      const atrasado = await um(c, `INSERT INTO refined.ticket_suporte (usuario_id, assunto, categoria_atendimento, sla_limite_em) VALUES ($1,'Atrasado','financeiro', now() - interval '1 hour') RETURNING *`, [u.id]);
      assert.equal(atrasado.sla_violado, true);
    }));

  it('rotina de SLA alcanca tickets parados que nao receberam escrita', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`ALTER TABLE refined.ticket_suporte DISABLE TRIGGER tg_ticket_sla`);
      await c.query(`INSERT INTO refined.ticket_suporte (usuario_id, assunto, categoria_atendimento, sla_limite_em) VALUES ($1,'Parado','duvida', now() - interval '2 hours')`, [u.id]);
      await c.query(`ALTER TABLE refined.ticket_suporte ENABLE TRIGGER tg_ticket_sla`);
      const r = await um(c, `SELECT refined.marcar_slas_violados() AS n`);
      assert.equal(r.n, 1);
      assert.equal((await um(c, `SELECT refined.marcar_slas_violados() AS n`)).n, 0);
    }));

  it('ticket resolvido exige data de resolucao e satisfacao vai de 1 a 5', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const t = await um(c, `INSERT INTO refined.ticket_suporte (usuario_id, assunto, categoria_atendimento) VALUES ($1,'x','duvida') RETURNING id`, [u.id]);
      await rejeita(c, `UPDATE refined.ticket_suporte SET status_principal = 'resolvido' WHERE id = $1`, [t.id], { codigo: CHECK });
      await rejeita(c, `UPDATE refined.ticket_suporte SET nivel_satisfacao = 6 WHERE id = $1`, [t.id], { codigo: CHECK });
      await c.query(`UPDATE refined.ticket_suporte SET status_principal = 'resolvido', resolvido_em = now(), nivel_satisfacao = 5 WHERE id = $1`, [t.id]);
    }));

  it('solicitacao LGPD tem prazo de 15 dias e so conclui com data de resolucao', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const s = await um(c, `INSERT INTO refined.solicitacao_titular_dados (usuario_id, tipo_solicitacao) VALUES ($1,'exclusao') RETURNING *`, [u.id]);
      const dias = (new Date(s.prazo_resposta) - new Date(s.criado_em)) / 86400e3;
      assert.ok(Math.abs(dias - 15) < 0.01);
      await rejeita(c, `UPDATE refined.solicitacao_titular_dados SET status = 'concluida' WHERE id = $1`, [s.id], { codigo: CHECK });
      await c.query(`UPDATE refined.solicitacao_titular_dados SET status = 'concluida', resolvido_em = now() WHERE id = $1`, [s.id]);
      const log = await contar(c, `SELECT count(*) AS n FROM refined.log_auditoria WHERE tabela_afetada = 'solicitacao_titular_dados'`);
      assert.equal(log, 2, 'pedido e conclusao ficam na trilha de auditoria');
    }));

  it('integracao externa: servico e status em dominio conhecido', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`INSERT INTO refined.integracao_externa (usuario_id, servico_terceiro, chave_api_externa) VALUES ($1,'alexa','cifrada')`, [u.id]);
      await rejeita(c, `INSERT INTO refined.integracao_externa (usuario_id, servico_terceiro, chave_api_externa) VALUES ($1,'siri','x')`, [u.id], { codigo: CHECK });
      await rejeita(c, `INSERT INTO refined.integracao_externa (usuario_id, servico_terceiro, chave_api_externa, escopo_permissao) VALUES ($1,'ifttt','x','[]')`, [u.id], { codigo: CHECK });
    }));
});
