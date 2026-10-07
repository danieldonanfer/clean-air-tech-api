import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comTransacao, contar, criarUsuario, rejeita, todas, um } from './_helpers.mjs';

const VIOLA_CHECK = '23514';
const VIOLA_UNICO = '23505';
const RESTRICAO = '23001';

describe('identidade e autenticacao', () => {
  it('e-mail e unico sem diferenciar maiusculas, mas pode ser reutilizado apos exclusao logica', () =>
    comTransacao(async (c) => {
      const a = await criarUsuario(c, 'a', { email: 'Ana@Teste.com' });
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash) VALUES ('X', 'ana@teste.com', 'h')`, [], { codigo: VIOLA_UNICO });
      await c.query(`UPDATE refined.usuario SET removido_em = now() WHERE id = $1`, [a.id]);
      await c.query(`INSERT INTO refined.usuario (nome_completo, email, senha_hash) VALUES ('Nova', 'ana@teste.com', 'h')`);
    }));

  it('telefone segue E.164 e so pode ser verificado se existir', () =>
    comTransacao(async (c) => {
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, telefone) VALUES ('T','t1@x.com','h','41999998888')`, [], { codigo: VIOLA_CHECK });
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, telefone) VALUES ('T','t2@x.com','h','(41) 99999-8888')`, [], { codigo: VIOLA_CHECK });
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, telefone_verificado) VALUES ('T','t3@x.com','h',true)`, [], { codigo: VIOLA_CHECK });
      await c.query(`INSERT INTO refined.usuario (nome_completo, email, senha_hash, telefone, telefone_verificado) VALUES ('T','t5@x.com','h','+5541999998888',true)`);
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, telefone) VALUES ('T','t4@x.com','h','+5541999998888')`, [], { codigo: VIOLA_UNICO });
    }));

  it('fuso horario precisa existir no banco IANA e idioma segue BCP 47', () =>
    comTransacao(async (c) => {
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, fuso_horario) VALUES ('T','f1@x.com','h','Brasilia/DF')`, [], { codigo: VIOLA_CHECK });
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, idioma_preferido) VALUES ('T','f2@x.com','h','portugues')`, [], { codigo: VIOLA_CHECK });
      const u = await um(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, fuso_horario, idioma_preferido) VALUES ('T','f3@x.com','h','Europe/Lisbon','pt-PT') RETURNING *`);
      assert.equal(u.fuso_horario, 'Europe/Lisbon');
    }));

  it('consentimento LGPD aceito exige a data do aceite', () =>
    comTransacao(async (c) => {
      await rejeita(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, consentimento_lgpd_aceito) VALUES ('T','l1@x.com','h',true)`, [], { codigo: VIOLA_CHECK });
    }));

  it('atualizado_em acompanha cada UPDATE', () =>
    comTransacao(async (c) => {
      const u = await um(c, `INSERT INTO refined.usuario (nome_completo, email, senha_hash, atualizado_em) VALUES ('T','at@x.com','h','2020-01-01') RETURNING *`);
      const depois = await um(c, `UPDATE refined.usuario SET nome_completo = 'Outro' WHERE id = $1 RETURNING atualizado_em`, [u.id]);
      assert.ok(new Date(depois.atualizado_em) > new Date('2020-01-02'));
    }));

  it('token de verificacao expira depois de criado e tem tipo conhecido', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await rejeita(c, `INSERT INTO refined.token_verificacao (usuario_id, tipo, token_hash, expira_em) VALUES ($1,'recuperacao_senha','h', now() - interval '1 minute')`, [u.id], { codigo: VIOLA_CHECK });
      await rejeita(c, `INSERT INTO refined.token_verificacao (usuario_id, tipo, token_hash, expira_em) VALUES ($1,'magia','h', now() + interval '10 minutes')`, [u.id], { codigo: VIOLA_CHECK });
      await c.query(`INSERT INTO refined.token_verificacao (usuario_id, tipo, token_hash, expira_em) VALUES ($1,'recuperacao_senha','h', now() + interval '30 minutes')`, [u.id]);
    }));

  it('login social: um vinculo por provedor/usuario e o id externo nao se repete entre contas', () =>
    comTransacao(async (c) => {
      const a = await criarUsuario(c, 'a');
      const b = await criarUsuario(c, 'b');
      await c.query(`INSERT INTO refined.login_provedor_externo (usuario_id, provedor, id_externo) VALUES ($1,'apple','001234.abcd')`, [a.id]);
      await rejeita(c, `INSERT INTO refined.login_provedor_externo (usuario_id, provedor, id_externo) VALUES ($1,'apple','001234.abcd')`, [b.id], { codigo: VIOLA_UNICO });
      await rejeita(c, `INSERT INTO refined.login_provedor_externo (usuario_id, provedor, id_externo) VALUES ($1,'apple','outro')`, [a.id], { codigo: VIOLA_UNICO });
      await c.query(`INSERT INTO refined.login_provedor_externo (usuario_id, provedor, id_externo) VALUES ($1,'google','g-1')`, [a.id]);
      await rejeita(c, `INSERT INTO refined.login_provedor_externo (usuario_id, provedor, id_externo) VALUES ($1,'orkut','x')`, [a.id], { codigo: VIOLA_CHECK });
    }));

  it('MFA: um registro por metodo e usuario', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`INSERT INTO refined.mfa_configuracao (usuario_id, metodo, segredo_criptografado) VALUES ($1,'totp','cifrado')`, [u.id]);
      await rejeita(c, `INSERT INTO refined.mfa_configuracao (usuario_id, metodo, segredo_criptografado) VALUES ($1,'totp','cifrado2')`, [u.id], { codigo: VIOLA_UNICO });
      await c.query(`INSERT INTO refined.mfa_configuracao (usuario_id, metodo, segredo_criptografado) VALUES ($1,'sms','cifrado3')`, [u.id]);
    }));

  it('RBAC: papel de cliente so para usuario, papel interno so para colaborador', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const col = await um(c, `INSERT INTO refined.colaborador (nome, email_corporativo, cargo) VALUES ('Sup','sup@clean.air','Suporte') RETURNING id`);
      const cliente = await um(c, `SELECT id FROM refined.papel WHERE nome = 'cliente_basico'`);
      const interno = await um(c, `SELECT id FROM refined.papel WHERE nome = 'suporte_nivel_1'`);
      await c.query(`INSERT INTO refined.usuario_papel VALUES ($1,$2)`, [u.id, cliente.id]);
      await rejeita(c, `INSERT INTO refined.usuario_papel VALUES ($1,$2)`, [u.id, interno.id], { codigo: VIOLA_CHECK });
      await c.query(`INSERT INTO refined.colaborador_papel VALUES ($1,$2)`, [col.id, interno.id]);
      await rejeita(c, `INSERT INTO refined.colaborador_papel VALUES ($1,$2)`, [col.id, cliente.id], { codigo: VIOLA_CHECK });
    }));

  it('chave de permissao segue o formato recurso.acao', () =>
    comTransacao(async (c) => {
      await rejeita(c, `INSERT INTO refined.permissao (chave) VALUES ('Dispositivo Gerenciar')`, [], { codigo: VIOLA_CHECK });
      await c.query(`INSERT INTO refined.permissao (chave) VALUES ('relatorio.exportar')`);
    }));
});

describe('auditoria', () => {
  it('registra insercao e alteracao sem jamais gravar segredos', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`UPDATE refined.usuario SET nome_completo = 'Nome Novo', senha_hash = 'novo-hash' WHERE id = $1`, [u.id]);
      const logs = await todas(c, `SELECT * FROM refined.log_auditoria WHERE tabela_afetada = 'usuario' AND registro_id = $1 ORDER BY id`, [u.id]);
      assert.deepEqual(logs.map((l) => l.operacao), ['insert', 'update']);
      assert.equal(logs[1].dado_anterior.nome_completo, u.nome_completo);
      assert.equal(logs[1].dado_novo.nome_completo, 'Nome Novo');
      for (const l of logs) {
        assert.ok(!('senha_hash' in (l.dado_novo ?? {})) && !('senha_hash' in (l.dado_anterior ?? {})), 'senha_hash vazou na auditoria');
      }
    }));

  it('nao registra ruido: login e tentativas falhas nao geram linha de auditoria', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const antes = await contar(c, `SELECT count(*) AS n FROM refined.log_auditoria WHERE registro_id = $1`, [u.id]);
      await c.query(`UPDATE refined.usuario SET ultimo_login_em = now(), tentativas_login_falhas = 3 WHERE id = $1`, [u.id]);
      const depois = await contar(c, `SELECT count(*) AS n FROM refined.log_auditoria WHERE registro_id = $1`, [u.id]);
      assert.equal(depois, antes);
    }));

  it('identifica quem executou, quando a sessao informa o usuario', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      await c.query(`SELECT set_config('app.usuario_id', $1, true)`, [u.id]);
      await c.query(`SELECT set_config('app.origem_execucao', 'admin', true)`);
      await c.query(`UPDATE refined.usuario SET status_conta = 'suspenso' WHERE id = $1`, [u.id]);
      const l = await um(c, `SELECT * FROM refined.log_auditoria WHERE registro_id = $1 AND operacao = 'update'`, [u.id]);
      assert.equal(l.usuario_executor_id, u.id);
      assert.equal(l.origem_execucao, 'admin');
    }));

  it('audita tabelas associativas pela chave composta', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c);
      const papel = await um(c, `SELECT id FROM refined.papel WHERE nome = 'cliente_basico'`);
      await c.query(`INSERT INTO refined.usuario_papel VALUES ($1,$2)`, [u.id, papel.id]);
      const l = await um(c, `SELECT registro_id FROM refined.log_auditoria WHERE tabela_afetada = 'usuario_papel'`);
      assert.equal(l.registro_id, `${u.id}:${papel.id}`);
    }));

  it('trilha e somente-insercao: UPDATE, DELETE e TRUNCATE sao recusados', () =>
    comTransacao(async (c) => {
      await criarUsuario(c);
      await rejeita(c, `UPDATE refined.log_auditoria SET operacao = 'delete'`, [], { codigo: RESTRICAO });
      await rejeita(c, `DELETE FROM refined.log_auditoria`, [], { codigo: RESTRICAO });
      await rejeita(c, `TRUNCATE refined.log_auditoria`, [], { codigo: RESTRICAO });
    }));
});
