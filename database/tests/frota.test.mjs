import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comTransacao, contar, criarDispositivo, criarLocal, criarUsuario, rejeita, todas, um } from './_helpers.mjs';

const CHECK = '23514';
const UNICO = '23505';

describe('ambientes', () => {
  it('quem cria o local vira membro proprietario automaticamente', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const m = await um(c, `SELECT * FROM refined.local_membro WHERE local_id = $1`, [l.id]);
      assert.equal(m.usuario_id, u.id);
      assert.equal(m.nivel_acesso, 'proprietario');
    }));

  it('hierarquia nao admite ciclos nem pai de si mesmo', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const casa = await criarLocal(c, u.id, { nome: 'Casa', tipo: 'residencia' });
      const sala = await criarLocal(c, u.id, { nome: 'Sala', paiId: casa.id });
      const canto = await criarLocal(c, u.id, { nome: 'Canto', paiId: sala.id });
      await rejeita(c, `UPDATE refined.local SET local_pai_id = $1 WHERE id = $2`, [canto.id, casa.id], { codigo: CHECK });
      await rejeita(c, `UPDATE refined.local SET local_pai_id = id WHERE id = $1`, [sala.id], { codigo: CHECK });
    }));

  it('latitude e longitude andam juntas e dentro dos limites', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await rejeita(c, `INSERT INTO refined.local (usuario_id, nome, tipo_local, latitude) VALUES ($1,'x','outro',-25.4)`, [u.id], { codigo: CHECK });
      await rejeita(c, `INSERT INTO refined.local (usuario_id, nome, tipo_local, latitude, longitude) VALUES ($1,'x','outro',-95,-49)`, [u.id], { codigo: CHECK });
      await c.query(`INSERT INTO refined.local (usuario_id, nome, tipo_local, latitude, longitude) VALUES ($1,'Curitiba','outro',-25.4284,-49.2733)`, [u.id]);
    }));
});

describe('dispositivo', () => {
  it('titular financeiro precisa ser proprietario do local', () =>
    comTransacao(async (c) => {
      const dono = await criarUsuario(c, 'dono');
      const estranho = await criarUsuario(c, 'estranho');
      const visitante = await criarUsuario(c, 'visita');
      const socio = await criarUsuario(c, 'socio');
      const l = await criarLocal(c, dono.id);
      await c.query(`INSERT INTO refined.local_membro (local_id, usuario_id, nivel_acesso) VALUES ($1,$2,'visualizador')`, [l.id, visitante.id]);
      await c.query(`INSERT INTO refined.local_membro (local_id, usuario_id, nivel_acesso) VALUES ($1,$2,'proprietario')`, [l.id, socio.id]);

      await criarDispositivo(c, l.id, dono.id);
      await criarDispositivo(c, l.id, socio.id);
      await rejeita(c, `INSERT INTO refined.dispositivo (local_id, usuario_proprietario_id, numero_serie, modelo) VALUES ($1,$2,'SN-X','m')`, [l.id, estranho.id], { codigo: CHECK });
      await rejeita(c, `INSERT INTO refined.dispositivo (local_id, usuario_proprietario_id, numero_serie, modelo) VALUES ($1,$2,'SN-Y','m')`, [l.id, visitante.id], { codigo: CHECK });
    }));

  it('mover o dispositivo para um local alheio e recusado', () =>
    comTransacao(async (c) => {
      const a = await criarUsuario(c, 'a');
      const b = await criarUsuario(c, 'b');
      const la = await criarLocal(c, a.id);
      const lb = await criarLocal(c, b.id);
      const d = await criarDispositivo(c, la.id, a.id);
      await rejeita(c, `UPDATE refined.dispositivo SET local_id = $1 WHERE id = $2`, [lb.id, d.id], { codigo: CHECK });
    }));

  it('nasce com o estado (device shadow) vazio e o numero de serie e unico', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id, { serie: 'SN-UNICO' });
      const e = await um(c, `SELECT * FROM refined.dispositivo_estado WHERE dispositivo_id = $1`, [d.id]);
      assert.deepEqual(e.estado_desejado, {});
      assert.deepEqual(e.estado_reportado, {});
      await rejeita(c, `INSERT INTO refined.dispositivo (local_id, usuario_proprietario_id, numero_serie, modelo) VALUES ($1,$2,'SN-UNICO','m')`, [l.id, u.id], { codigo: UNICO });
    }));

  it('intervalo de captacao e configuravel de 1 s a 60 min (padrao 60 s)', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      assert.equal(d.intervalo_captacao_segundos, 60);
      for (const ok of [1, 3600]) await c.query(`UPDATE refined.dispositivo SET intervalo_captacao_segundos = $1 WHERE id = $2`, [ok, d.id]);
      for (const ruim of [0, 3601, -5]) {
        await rejeita(c, `UPDATE refined.dispositivo SET intervalo_captacao_segundos = $1 WHERE id = $2`, [ruim, d.id], { codigo: CHECK });
      }
    }));

  it('bateria entre 0 e 100 e conexao em valores conhecidos', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      await rejeita(c, `UPDATE refined.dispositivo SET nivel_bateria_percentual = 101 WHERE id = $1`, [d.id], { codigo: CHECK });
      await rejeita(c, `UPDATE refined.dispositivo SET status_conexao = 'meio_online' WHERE id = $1`, [d.id], { codigo: CHECK });
    }));

  it('telemetria nao polui a auditoria, mas mudanca de negocio sim', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      const n = () => contar(c, `SELECT count(*) AS n FROM refined.log_auditoria WHERE tabela_afetada = 'dispositivo' AND registro_id = $1`, [d.id]);
      assert.equal(await n(), 1);
      await c.query(`UPDATE refined.dispositivo SET ultimo_contato_em = now(), nivel_bateria_percentual = 80, intensidade_sinal_dbm = -60 WHERE id = $1`, [d.id]);
      assert.equal(await n(), 1);
      await c.query(`UPDATE refined.dispositivo SET status_dispositivo = 'manutencao' WHERE id = $1`, [d.id]);
      assert.equal(await n(), 2);
    }));
});

describe('firmware (SCD tipo 2)', () => {
  it('nova versao fecha a anterior e passa a ser a atual do dispositivo', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      const v1 = await um(c, `INSERT INTO refined.firmware_versao (dispositivo_id, versao_codigo, valido_de) VALUES ($1,'1.0.0','2026-01-01') RETURNING *`, [d.id]);
      assert.equal((await um(c, `SELECT firmware_versao_atual_id AS id FROM refined.dispositivo WHERE id = $1`, [d.id])).id, v1.id);

      const v2 = await um(c, `INSERT INTO refined.firmware_versao (dispositivo_id, versao_codigo, valido_de) VALUES ($1,'1.1.0','2026-03-01') RETURNING *`, [d.id]);
      const antigo = await um(c, `SELECT * FROM refined.firmware_versao WHERE id = $1`, [v1.id]);
      assert.equal(antigo.registro_atual, false);
      assert.equal(new Date(antigo.valido_ate).getTime(), new Date(v2.valido_de).getTime(), 'a vigencia da v1 termina quando a v2 comeca');
      assert.equal((await um(c, `SELECT firmware_versao_atual_id AS id FROM refined.dispositivo WHERE id = $1`, [d.id])).id, v2.id);
      assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.firmware_versao WHERE dispositivo_id = $1 AND registro_atual`, [d.id]), 1);
    }));

  it('instalacao com falha fica registrada mas nunca vira a versao atual', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      const v1 = await um(c, `INSERT INTO refined.firmware_versao (dispositivo_id, versao_codigo) VALUES ($1,'1.0.0') RETURNING id`, [d.id]);
      await rejeita(c, `INSERT INTO refined.firmware_versao (dispositivo_id, versao_codigo, resultado_instalacao) VALUES ($1,'2.0.0','falha')`, [d.id], { codigo: CHECK });
      await c.query(`INSERT INTO refined.firmware_versao (dispositivo_id, versao_codigo, resultado_instalacao, registro_atual) VALUES ($1,'2.0.0','falha',false)`, [d.id]);
      assert.equal((await um(c, `SELECT firmware_versao_atual_id AS id FROM refined.dispositivo WHERE id = $1`, [d.id])).id, v1.id);
      assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.firmware_versao WHERE dispositivo_id = $1`, [d.id]), 2);
    }));
});

describe('modelo de IA (SCD tipo 2 com rollback)', () => {
  it('mantem uma versao vigente por modelo e permite reverter preservando o historico', () =>
    comTransacao(async (c) => {
      const ins = (v, de) => um(c, `INSERT INTO refined.modelo_ia_versao (nome_modelo, versao_codigo, valido_de) VALUES ('recomendacao_qualidade_ar',$1,$2) RETURNING *`, [v, de]);
      await ins('1.0', '2026-01-01');
      await ins('2.0', '2026-02-01');
      await um(c, `INSERT INTO refined.modelo_ia_versao (nome_modelo, versao_codigo) VALUES ('classificador_evento_sonoro','1.0') RETURNING id`);
      await c.query(`SELECT refined.reverter_modelo_ia('recomendacao_qualidade_ar', '1.0')`);

      const hist = await todas(c, `SELECT versao_codigo, registro_atual FROM refined.modelo_ia_versao WHERE nome_modelo = 'recomendacao_qualidade_ar'`);
      assert.equal(hist.length, 3, 'o rollback adiciona uma vigencia, nao apaga nada');
      assert.deepEqual(hist.filter((h) => h.registro_atual).map((h) => h.versao_codigo), ['1.0']);
      assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.modelo_ia_versao WHERE registro_atual`), 2, 'cada modelo tem sua propria versao vigente');
      await rejeita(c, `SELECT refined.reverter_modelo_ia('recomendacao_qualidade_ar', '9.9')`, [], { codigo: 'P0002' });
    }));
});

describe('frota, rollout e fabricacao', () => {
  it('feature flag: percentual 0-100 e periodo coerente', () =>
    comTransacao(async (c) => {
      await rejeita(c, `INSERT INTO refined.feature_flag (chave, tipo_alvo, percentual_rollout) VALUES ('f1','firmware',101)`, [], { codigo: CHECK });
      await rejeita(c, `INSERT INTO refined.feature_flag (chave, tipo_alvo, iniciado_em, concluido_em) VALUES ('f2','firmware','2026-02-01','2026-01-01')`, [], { codigo: CHECK });
      await c.query(`INSERT INTO refined.feature_flag (chave, tipo_alvo, percentual_rollout, criterio_alvo) VALUES ('fw-2.0-canario','firmware',5,'{"modelo":"CAT-1"}')`);
      await rejeita(c, `INSERT INTO refined.feature_flag (chave, tipo_alvo) VALUES ('fw-2.0-canario','firmware')`, [], { codigo: UNICO });
    }));

  it('grupos: N:M entre dispositivo e grupo', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d1 = await criarDispositivo(c, l.id, u.id);
      const d2 = await criarDispositivo(c, l.id, u.id);
      const g = await um(c, `INSERT INTO refined.grupo_dispositivo (nome, criterio) VALUES ('piloto-curitiba','{"cidade":"Curitiba"}') RETURNING id`);
      await c.query(`INSERT INTO refined.dispositivo_grupo VALUES ($1,$2),($3,$2)`, [d1.id, g.id, d2.id]);
      await rejeita(c, `INSERT INTO refined.dispositivo_grupo VALUES ($1,$2)`, [d1.id, g.id], { codigo: UNICO });
      assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.dispositivo_grupo WHERE grupo_id = $1`, [g.id]), 2);
    }));

  it('garantia e 1:N com o dispositivo (RMA gera novo periodo) e o periodo e coerente', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const l = await criarLocal(c, u.id);
      const d = await criarDispositivo(c, l.id, u.id);
      await c.query(`INSERT INTO refined.garantia_dispositivo (dispositivo_id, data_compra, data_fim_garantia) VALUES ($1,'2026-01-01','2027-01-01')`, [d.id]);
      await c.query(`INSERT INTO refined.garantia_dispositivo (dispositivo_id, data_compra, data_fim_garantia, canal_venda) VALUES ($1,'2026-08-01','2027-08-01','rma')`, [d.id]);
      await rejeita(c, `INSERT INTO refined.garantia_dispositivo (dispositivo_id, data_compra, data_fim_garantia) VALUES ($1,'2026-08-01','2026-01-01')`, [d.id], { codigo: CHECK });
      assert.equal(await contar(c, `SELECT count(*) AS n FROM refined.garantia_dispositivo WHERE dispositivo_id = $1`, [d.id]), 2);
    }));

  it('lote e certificacao respeitam dominios', () =>
    comTransacao(async (c) => {
      await rejeita(c, `INSERT INTO refined.lote_fabricacao (numero_lote, data_fabricacao, quantidade_unidades) VALUES ('L1','2026-01-01',0)`, [], { codigo: CHECK });
      await c.query(`INSERT INTO refined.lote_fabricacao (numero_lote, data_fabricacao, quantidade_unidades) VALUES ('L1','2026-01-01',100)`);
      await rejeita(c, `INSERT INTO refined.lote_fabricacao (numero_lote, data_fabricacao, quantidade_unidades) VALUES ('L1','2026-02-01',50)`, [], { codigo: UNICO });
      await rejeita(c, `INSERT INTO refined.certificacao_dispositivo (modelo, tipo_certificacao, laboratorio, validade_ate) VALUES ('CAT-1','inmetro','lab','2030-01-01')`, [], { codigo: CHECK });
      for (const t of ['anatel', 'ce', 'fcc', 'rohs', 'weee']) {
        await c.query(`INSERT INTO refined.certificacao_dispositivo (modelo, tipo_certificacao, laboratorio, validade_ate) VALUES ('CAT-1',$1,'lab','2030-01-01')`, [t]);
      }
    }));
});

describe('multi-organizacao', () => {
  it('usuario pertence a varias organizacoes e a organizacao pode ser dona de locais', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const escola = await um(c, `INSERT INTO refined.organizacao (nome_fantasia, tipo) VALUES ('Escola Sol','escola') RETURNING id`);
      const hosp = await um(c, `INSERT INTO refined.organizacao (nome_fantasia, tipo) VALUES ('Hospital Vida','hospital') RETURNING id`);
      await c.query(`INSERT INTO refined.usuario_organizacao (usuario_id, organizacao_id, papel_na_organizacao) VALUES ($1,$2,'gestor'),($1,$3,'membro')`, [u.id, escola.id, hosp.id]);
      await rejeita(c, `INSERT INTO refined.usuario_organizacao (usuario_id, organizacao_id, papel_na_organizacao) VALUES ($1,$2,'rei')`, [u.id, escola.id], { codigo: CHECK });
      const l = await criarLocal(c, u.id, { organizacaoId: escola.id });
      assert.equal(l.organizacao_id, escola.id);
      await rejeita(c, `INSERT INTO refined.organizacao (nome_fantasia, tipo) VALUES ('X','ong')`, [], { codigo: CHECK });
    }));
});
