import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comoPapel, comoApp, comTransacao, contar, criarDispositivo, criarLocal, criarUsuario, rejeita, todas, um } from './_helpers.mjs';

const SEM_PERMISSAO = '42501';

// Ana (dona de uma casa), Beto (outra casa; visualizador na casa da Ana), Carla (gestora de uma escola),
// Davi (apenas membro da escola) e Eva (sem relacao com ninguem).
async function cenario(c) {
  const U = {};
  for (const n of ['ana', 'beto', 'carla', 'davi', 'eva']) U[n] = await criarUsuario(c, n);
  const escola = await um(c, `INSERT INTO refined.organizacao (nome_fantasia, tipo) VALUES ('Escola Sol','escola') RETURNING id`);
  await c.query(`INSERT INTO refined.usuario_organizacao VALUES ($1,$2,'gestor'),($3,$2,'membro')`, [U.carla.id, escola.id, U.davi.id]);

  const casaAna = await criarLocal(c, U.ana.id, { nome: 'Casa da Ana' });
  const casaBeto = await criarLocal(c, U.beto.id, { nome: 'Casa do Beto' });
  const salaEscola = await criarLocal(c, U.carla.id, { nome: 'Sala 1', organizacaoId: escola.id });
  await c.query(`INSERT INTO refined.local_membro (local_id, usuario_id, nivel_acesso) VALUES ($1,$2,'visualizador')`, [casaAna.id, U.beto.id]);

  const dAna = await criarDispositivo(c, casaAna.id, U.ana.id, { serie: 'SN-ANA' });
  const dBeto = await criarDispositivo(c, casaBeto.id, U.beto.id, { serie: 'SN-BETO' });
  const dEscola = await criarDispositivo(c, salaEscola.id, U.carla.id, { serie: 'SN-ESCOLA' });

  for (const d of [dAna, dBeto, dEscola]) {
    await c.query(`INSERT INTO refined.leitura_sensor (dispositivo_id, medido_em, pm25_microg_m3, origem_dado) VALUES ($1, now(), 10, 'wifi'), ($1, now() + interval '1 minute', 11, 'wifi')`, [d.id]);
  }
  const alertaAna = await um(c, `INSERT INTO refined.alerta (dispositivo_id, usuario_id, medido_em_referencia, tipo_alerta, nivel_severidade, valor_medido, limiar_referencia) VALUES ($1,$2,now(),'pm25_alto','critico',90,35) RETURNING *`, [dAna.id, U.ana.id]);
  await c.query(`INSERT INTO refined.recomendacao (alerta_id, texto_recomendacao, categoria_acao) VALUES ($1,'Ligue o purificador','purificacao')`, [alertaAna.id]);
  return { ...U, escola, casaAna, casaBeto, salaEscola, dAna, dBeto, dEscola, alertaAna };
}

const ids = (linhas) => linhas.map((l) => l.id ?? l.numero_serie ?? l.nome).sort();

describe('RLS: isolamento entre usuarios', () => {
  it('cada usuario ve apenas a si mesmo e nunca o hash da senha', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.ana.id, async () => {
        assert.deepEqual(ids(await todas(c, `SELECT id FROM refined.usuario`)), [t.ana.id]);
        await rejeita(c, `SELECT senha_hash FROM refined.usuario`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT * FROM refined.usuario`, [], { codigo: SEM_PERMISSAO });
      });
    }));

  it('sem usuario na sessao, nada e visivel (falha fechada)', () =>
    comTransacao(async (c) => {
      await cenario(c);
      await comoPapel(c, 'clean_air_app', null, async () => {
        for (const tabela of ['usuario', 'local', 'dispositivo', 'alerta', 'ticket_suporte']) {
          assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.${tabela}`), 0, tabela);
        }
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.v_leitura_sensor_usuario`), 0);
      });
    }));

  it('usuario nao se promove nem muda o proprio status: colunas protegidas por GRANT', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.ana.id, async () => {
        await c.query(`UPDATE refined.usuario SET nome_completo = 'Ana Maria' WHERE id = $1`, [t.ana.id]);
        await rejeita(c, `UPDATE refined.usuario SET papel_usuario = 'gestor' WHERE id = $1`, [t.ana.id], { codigo: SEM_PERMISSAO });
        await rejeita(c, `UPDATE refined.usuario SET status_conta = 'ativo' WHERE id = $1`, [t.ana.id], { codigo: SEM_PERMISSAO });
        await rejeita(c, `UPDATE refined.usuario SET senha_hash = 'x' WHERE id = $1`, [t.ana.id], { codigo: SEM_PERMISSAO });
        const alheio = await c.query(`UPDATE refined.usuario SET nome_completo = 'Hackeado' WHERE id = $1`, [t.beto.id]);
        assert.equal(alheio.rowCount, 0, 'RLS: a linha de outro usuario simplesmente nao existe para a Ana');
      });
    }));

  it('ambientes e dispositivos: dono, convidado e gestor de organizacao', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.ana.id, async () => {
        assert.deepEqual(ids(await todas(c, `SELECT id FROM refined.local`)), [t.casaAna.id]);
        assert.deepEqual(ids(await todas(c, `SELECT numero_serie FROM refined.dispositivo`)), ['SN-ANA']);
      });
      await comoApp(c, t.beto.id, async () => {
        assert.deepEqual(ids(await todas(c, `SELECT id FROM refined.local`)), ids([t.casaAna, t.casaBeto]), 've a propria casa e a que foi compartilhada');
        assert.deepEqual(ids(await todas(c, `SELECT numero_serie FROM refined.dispositivo`)), ['SN-ANA', 'SN-BETO']);
      });
      await comoApp(c, t.carla.id, async () => {
        assert.deepEqual(ids(await todas(c, `SELECT numero_serie FROM refined.dispositivo`)), ['SN-ESCOLA']);
      });
      await comoApp(c, t.davi.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.dispositivo`), 0, 'membro comum da escola nao ve os dispositivos da organizacao');
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.organizacao`), 1, 'mas enxerga a propria organizacao');
      });
      await comoApp(c, t.eva.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.local`), 0);
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.organizacao`), 0);
      });
    }));

  it('visualizador ve mas nao altera o que foi compartilhado', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.beto.id, async () => {
        const r = await c.query(`UPDATE refined.dispositivo SET intervalo_captacao_segundos = 5 WHERE id = $1`, [t.dAna.id]);
        assert.equal(r.rowCount, 0);
        const l = await c.query(`UPDATE refined.local SET nome = 'Invadida' WHERE id = $1`, [t.casaAna.id]);
        assert.equal(l.rowCount, 0);
        await rejeita(c, `INSERT INTO refined.local_membro (local_id, usuario_id, nivel_acesso) VALUES ($1,$2,'proprietario')`, [t.casaAna.id, t.beto.id], { codigo: SEM_PERMISSAO });
        const e = await c.query(`UPDATE refined.dispositivo_estado SET estado_desejado = '{"x":1}' WHERE dispositivo_id = $1`, [t.dAna.id]);
        assert.equal(e.rowCount, 0);
      });
      await comoApp(c, t.ana.id, async () => {
        const e = await c.query(`UPDATE refined.dispositivo_estado SET estado_desejado = '{"intervalo_captacao_segundos":30}' WHERE dispositivo_id = $1`, [t.dAna.id]);
        assert.equal(e.rowCount, 1, 'a dona configura o estado desejado (device shadow)');
      });
    }));

  it('nao e possivel cadastrar dispositivo ou local em nome de outro nem em ambiente alheio', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.ana.id, async () => {
        await rejeita(c, `INSERT INTO refined.dispositivo (local_id, usuario_proprietario_id, numero_serie, modelo) VALUES ($1,$2,'SN-INVASOR','m')`, [t.casaBeto.id, t.ana.id]); // barrado pelo gatilho (23514) e, se ele faltasse, pela RLS
        await rejeita(c, `INSERT INTO refined.dispositivo (local_id, usuario_proprietario_id, numero_serie, modelo) VALUES ($1,$2,'SN-FALSO','m')`, [t.casaAna.id, t.beto.id]);
        await rejeita(c, `INSERT INTO refined.local (usuario_id, nome, tipo_local) VALUES ($1,'em nome do Beto','outro')`, [t.beto.id], { codigo: SEM_PERMISSAO });
        await rejeita(c, `INSERT INTO refined.local (usuario_id, nome, tipo_local, organizacao_id) VALUES ($1,'falsa filial','outro',$2)`, [t.ana.id, t.escola.id], { codigo: SEM_PERMISSAO });
      });
    }));

  it('o fluxo normal do usuario funciona: cria local, pareia dispositivo e recebe RETURNING', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.eva.id, async () => {
        const l = await um(c, `INSERT INTO refined.local (usuario_id, nome, tipo_local) VALUES ($1,'Meu quarto','comodo') RETURNING id`, [t.eva.id]);
        const d = await um(c, `INSERT INTO refined.dispositivo (local_id, usuario_proprietario_id, numero_serie, modelo) VALUES ($1,$2,'SN-EVA','CAT-1') RETURNING id`, [l.id, t.eva.id]);
        assert.ok(d.id);
        const estado = await contar(c, `SELECT count(*) AS n FROM refined.dispositivo_estado WHERE dispositivo_id = $1`, [d.id]);
        assert.equal(estado, 1, 'o gatilho (SECURITY DEFINER) criou o estado mesmo sem o usuario poder inserir nele');
        const removido = await c.query(`UPDATE refined.dispositivo SET removido_em = now() WHERE id = $1`, [d.id]);
        assert.equal(removido.rowCount, 1, 'exclusao logica pelo proprio usuario');
      });
    }));
});

describe('RLS: leituras, alertas e dados derivados', () => {
  it('leituras so pela view filtrada; a tabela base e inacessivel ao usuario final', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.ana.id, async () => {
        await rejeita(c, `SELECT * FROM refined.leitura_sensor`, [], { codigo: SEM_PERMISSAO });
        const l = await todas(c, `SELECT dispositivo_id FROM refined.v_leitura_sensor_usuario`);
        assert.equal(l.length, 2);
        assert.ok(l.every((x) => x.dispositivo_id === t.dAna.id));
      });
      await comoApp(c, t.beto.id, async () => {
        const dispositivos = new Set((await todas(c, `SELECT dispositivo_id FROM refined.v_leitura_sensor_usuario`)).map((x) => x.dispositivo_id));
        assert.deepEqual([...dispositivos].sort(), [t.dAna.id, t.dBeto.id].sort());
      });
      await comoApp(c, t.carla.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.v_leitura_sensor_usuario`), 2);
      });
    }));

  it('dispositivo removido deixa de aparecer nas leituras', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await c.query(`UPDATE refined.dispositivo SET removido_em = now() WHERE id = $1`, [t.dAna.id]);
      await comoApp(c, t.ana.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.v_leitura_sensor_usuario`), 0);
      });
    }));

  it('alertas, recomendacoes e notificacoes seguem o dono do alerta', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await c.query(`INSERT INTO refined.notificacao_enviada (usuario_id, alerta_id, canal_envio) VALUES ($1,$2,'push')`, [t.ana.id, t.alertaAna.id]);
      await comoApp(c, t.ana.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.alerta`), 1);
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.recomendacao`), 1);
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.notificacao_enviada`), 1);
        const ok = await c.query(`UPDATE refined.recomendacao SET aceita_pelo_usuario = true`);
        assert.equal(ok.rowCount, 1);
        const lido = await c.query(`UPDATE refined.notificacao_enviada SET status_principal = 'lida', lido_em = now()`);
        assert.equal(lido.rowCount, 1);
      });
      await comoApp(c, t.beto.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.alerta`), 0);
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.recomendacao`), 0, 'a recomendacao herda a visibilidade do alerta');
        assert.equal((await c.query(`UPDATE refined.recomendacao SET aceita_pelo_usuario = false`)).rowCount, 0);
        assert.equal((await c.query(`UPDATE refined.alerta SET status_principal = 'resolvido'`)).rowCount, 0);
      });
    }));

  it('usuario nao altera o conteudo do alerta, so o status', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.ana.id, async () => {
        await c.query(`UPDATE refined.alerta SET status_principal = 'reconhecido' WHERE id = $1`, [t.alertaAna.id]);
        await rejeita(c, `UPDATE refined.alerta SET valor_medido = 1 WHERE id = $1`, [t.alertaAna.id], { codigo: SEM_PERMISSAO });
        await rejeita(c, `INSERT INTO refined.alerta (dispositivo_id, usuario_id, medido_em_referencia, tipo_alerta, nivel_severidade, valor_medido, limiar_referencia) VALUES ($1,$2,now(),'pm25_alto','info',1,1)`, [t.dAna.id, t.ana.id], { codigo: SEM_PERMISSAO });
      });
    }));

  it('suporte, LGPD e plano: o usuario ve e abre os proprios, nunca os alheios', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await c.query(`INSERT INTO refined.assinatura_plano (usuario_id) VALUES ($1), ($2)`, [t.ana.id, t.beto.id]);
      await c.query(`INSERT INTO refined.saude_conta (usuario_id, pontuacao_saude, risco_cancelamento) VALUES ($1, 20, 'alto')`, [t.ana.id]);
      await comoApp(c, t.ana.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.assinatura_plano`), 1);
        await rejeita(c, `SELECT * FROM refined.saude_conta`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT * FROM refined.log_auditoria`, [], { codigo: SEM_PERMISSAO });
        await c.query(`INSERT INTO refined.ticket_suporte (usuario_id, dispositivo_id, assunto, categoria_atendimento) VALUES ($1,$2,'Ajuda','tecnico')`, [t.ana.id, t.dAna.id]);
        await rejeita(c, `INSERT INTO refined.ticket_suporte (usuario_id, dispositivo_id, assunto, categoria_atendimento) VALUES ($1,$2,'Xeretando','tecnico')`, [t.ana.id, t.dBeto.id], { codigo: SEM_PERMISSAO });
        await c.query(`INSERT INTO refined.solicitacao_titular_dados (usuario_id, tipo_solicitacao) VALUES ($1,'portabilidade')`, [t.ana.id]);
        await rejeita(c, `INSERT INTO refined.solicitacao_titular_dados (usuario_id, tipo_solicitacao) VALUES ($1,'exclusao')`, [t.beto.id], { codigo: SEM_PERMISSAO });
        await rejeita(c, `UPDATE refined.solicitacao_titular_dados SET status = 'concluida'`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `UPDATE refined.assinatura_plano SET nivel_plano = 'enterprise'`, [], { codigo: SEM_PERMISSAO });
      });
      await comoApp(c, t.beto.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.ticket_suporte`), 0);
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.solicitacao_titular_dados`), 0);
      });
    }));

  it('token de verificacao e segredo de MFA nunca chegam ao usuario final; sessao sem o hash do token', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await c.query(`INSERT INTO refined.token_verificacao (usuario_id, tipo, token_hash, expira_em) VALUES ($1,'recuperacao_senha','h', now() + interval '1 hour')`, [t.ana.id]);
      await c.query(`INSERT INTO refined.mfa_configuracao (usuario_id, metodo, segredo_criptografado) VALUES ($1,'totp','segredo')`, [t.ana.id]);
      await c.query(`INSERT INTO refined.sessao_autenticacao (usuario_id, token_hash, expira_em) VALUES ($1,'tok-ana', now() + interval '1 day'), ($2,'tok-beto', now() + interval '1 day')`, [t.ana.id, t.beto.id]);
      await comoApp(c, t.ana.id, async () => {
        await rejeita(c, `SELECT * FROM refined.token_verificacao`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT * FROM refined.mfa_configuracao`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT token_hash FROM refined.sessao_autenticacao`, [], { codigo: SEM_PERMISSAO });
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.sessao_autenticacao`), 1, 've so a propria sessao, para poder revoga-la');
        const r = await c.query(`UPDATE refined.sessao_autenticacao SET revogado_em = now()`);
        assert.equal(r.rowCount, 1);
      });
    }));

  it('gestor da organizacao administra os membros; membro comum nao', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoApp(c, t.carla.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.usuario_organizacao`), 2);
        await c.query(`INSERT INTO refined.usuario_organizacao VALUES ($1,$2,'membro')`, [t.eva.id, t.escola.id]);
      });
      await comoApp(c, t.davi.id, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.usuario_organizacao`), 1);
        await rejeita(c, `INSERT INTO refined.usuario_organizacao VALUES ($1,$2,'gestor')`, [t.davi.id, t.escola.id], { codigo: SEM_PERMISSAO });
      });
    }));
});

describe('privilegio minimo nos papeis de servico', () => {
  it('ingestao grava raw e leituras, gera alertas e atualiza so a telemetria', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoPapel(c, 'clean_air_ingestao', null, async () => {
        const lote = await um(c, `INSERT INTO raw.lote_ingestao (origem) VALUES ('wifi') RETURNING id`);
        await c.query(`INSERT INTO raw.leitura_bruta (lote_ingestao_id, numero_serie, medido_em, payload) VALUES ($1,'SN-ANA','2026-05-01T10:00:00Z','{"pm25_microg_m3": 7}')`, [lote.id]);
        const r = await um(c, `SELECT * FROM refined.carregar_leituras_do_raw()`);
        assert.equal(r.inseridas, 1);
        await c.query(`INSERT INTO refined.alerta (dispositivo_id, usuario_id, medido_em_referencia, tipo_alerta, nivel_severidade, valor_medido, limiar_referencia) VALUES ($1,$2,now(),'co2_alto','atencao',1500,1000)`, [t.dAna.id, t.ana.id]);
        await c.query(`UPDATE refined.dispositivo SET status_conexao = 'online', ultimo_contato_em = now(), nivel_bateria_percentual = 77 WHERE id = $1`, [t.dAna.id]);
        await rejeita(c, `UPDATE refined.dispositivo SET usuario_proprietario_id = $2 WHERE id = $1`, [t.dAna.id, t.beto.id], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT * FROM refined.usuario`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT * FROM refined.log_auditoria`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT * FROM trusted.fato_leitura`, [], { codigo: SEM_PERMISSAO });
      });
    }));

  it('analitico le apenas a camada trusted', () =>
    comTransacao(async (c) => {
      await cenario(c);
      await comoPapel(c, 'clean_air_analitico', null, async () => {
        assert.equal(await contar(c, `SELECT count(*) AS n FROM trusted.fato_leitura`), 0);
        await rejeita(c, `SELECT * FROM refined.usuario`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT * FROM raw.leitura_bruta`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `INSERT INTO trusted.dim_tempo (tempo_key, ano, trimestre, mes, nome_mes, semana_iso, dia_do_mes, dia_da_semana, nome_dia, fim_de_semana) VALUES ('2026-01-01',2026,1,1,'janeiro',1,1,4,'quinta',false)`, [], { codigo: SEM_PERMISSAO });
      });
    }));

  it('auth cria contas e tokens, mas nao enxerga dispositivos', () =>
    comTransacao(async (c) => {
      const t = await cenario(c);
      await comoPapel(c, 'clean_air_auth', null, async () => {
        const u = await um(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash) VALUES ('Nova','nova@x.com','h') RETURNING id`);
        await c.query(`INSERT INTO refined.token_verificacao (usuario_id, tipo, token_hash, expira_em) VALUES ($1,'verificacao_email','h', now() + interval '1 hour')`, [u.id]);
        await c.query(`INSERT INTO refined.assinatura_plano (usuario_id) VALUES ($1)`, [u.id]);
        assert.ok(await contar(c, `SELECT count(*) AS n FROM refined.usuario WHERE id = $1`, [t.ana.id]) === 1, 'auth consulta qualquer conta no login');
        await rejeita(c, `SELECT * FROM refined.dispositivo`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `DELETE FROM refined.usuario WHERE id = $1`, [t.ana.id], { codigo: SEM_PERMISSAO });
      });
    }));

  it('funcoes de carga e manutencao nao ficam abertas a qualquer papel', () =>
    comTransacao(async (c) => {
      await cenario(c);
      await comoPapel(c, 'clean_air_app', null, async () => {
        await rejeita(c, `SELECT refined.carregar_leituras_do_raw()`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT trusted.carregar_fato_leitura()`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT refined.marcar_slas_violados()`, [], { codigo: SEM_PERMISSAO });
        await rejeita(c, `SELECT refined.reverter_modelo_ia('x','1')`, [], { codigo: SEM_PERMISSAO });
      });
    }));
});
