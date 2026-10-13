import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { SENHA_BOA, api, emailUnico, iniciar, telefoneUnico, um, type Ambiente } from './_ambiente.ts';

describe('POST /v1/auth/cadastro', () => {
  let amb: Ambiente;
  let http: ReturnType<typeof api>;
  before(async () => {
    amb = await iniciar();
    http = api(amb);
  });
  after(() => amb.fechar());

  it('cria a conta e já devolve a sessão e o usuário no formato do front', async () => {
    const email = emailUnico('Ana.');
    const r = await http.post('/v1/auth/cadastro', {
      nome: '  Ana Silva ',
      email: email.toUpperCase(),
      telefone: '(11) 98765-4321',
      senha: SENHA_BOA,
      objetivo: 'alergia',
      aceitouTermos: true,
    });
    assert.equal(r.status, 201);
    assert.match(r.corpo.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(Object.keys(r.corpo.usuario).sort(), [
      'apelido', 'email', 'funcao', 'idioma', 'membroDesde', 'nome', 'objetivo', 'telefone',
    ]);
    assert.equal(r.corpo.usuario.nome, 'Ana Silva');
    assert.equal(r.corpo.usuario.apelido, 'Ana');
    assert.equal(r.corpo.usuario.email, email.toLowerCase());
    assert.equal(r.corpo.usuario.telefone, '+5511987654321');
    assert.equal(r.corpo.usuario.funcao, 'Cliente');
    assert.equal(r.corpo.usuario.idioma, 'Português (Brasil)');
    assert.equal(r.corpo.usuario.objetivo, 'Controle de alergias e asma');
    assert.match(r.corpo.usuario.membroDesde, /^[a-zç]+ de \d{4}$/);
  });

  it('grava tudo no banco: hash argon2id, consentimento, plano, papel, preferências e sessão', async () => {
    const conta = await http.cadastrar();
    const u = await um(amb.admin, `SELECT * FROM refined.usuario WHERE email = $1`, [conta.email]);
    assert.match(u.senha_hash, /^\$argon2id\$/);
    assert.ok(!u.senha_hash.includes(SENHA_BOA));
    assert.equal(u.consentimento_lgpd_aceito, true);
    assert.ok(u.consentimento_lgpd_data);
    assert.ok(u.termos_uso_versao_aceita);
    assert.ok(u.termos_uso_aceito_em);
    assert.equal(u.objetivo_uso, 'ar');
    assert.equal(u.status_conta, 'ativo');

    const plano = await um(amb.admin, `SELECT nivel_plano, data_fim FROM refined.assinatura_plano WHERE usuario_id = $1`, [u.id]);
    assert.equal(plano.nivel_plano, 'gratuito');
    assert.equal(plano.data_fim, null);

    const papel = await um(
      amb.admin,
      `SELECT p.nome FROM refined.usuario_papel up JOIN refined.papel p ON p.id = up.papel_id WHERE up.usuario_id = $1`,
      [u.id],
    );
    assert.equal(papel.nome, 'cliente_basico');

    const prefs = await um(amb.admin, `SELECT count(*)::int AS n FROM refined.preferencia_notificacao WHERE usuario_id = $1`, [u.id]);
    assert.ok(prefs.n > 0);

    // O banco guarda só o SHA-256 do token, nunca o token.
    const sessao = await um(amb.admin, `SELECT token_hash, expira_em - criado_em AS validade FROM refined.sessao_autenticacao WHERE usuario_id = $1`, [u.id]);
    assert.equal(sessao.token_hash, createHash('sha256').update(conta.token).digest('hex'));
    assert.notEqual(sessao.token_hash, conta.token);
    assert.equal(sessao.validade.days, 7);
  });

  it('a auditoria registra o cadastro sem o hash da senha', async () => {
    const conta = await http.cadastrar();
    const u = await um(amb.admin, `SELECT id FROM refined.usuario WHERE email = $1`, [conta.email]);
    const log = await um(
      amb.admin,
      `SELECT dado_novo FROM refined.log_auditoria WHERE tabela_afetada = 'usuario' AND registro_id = $1 AND operacao = 'insert'`,
      [u.id],
    );
    assert.ok(log, 'cadastro não foi auditado');
    assert.equal(log.dado_novo.senha_hash, undefined);
  });

  it('a conta é criada sem telefone quando ele não é informado', async () => {
    const r = await http.post('/v1/auth/cadastro', {
      nome: 'Sem Telefone', email: emailUnico(), senha: SENHA_BOA, objetivo: 'outro', aceitouTermos: true,
    });
    assert.equal(r.status, 201);
    assert.equal(r.corpo.usuario.telefone, '');
  });

  it('e-mail repetido (sem diferenciar maiúsculas) responde 409 EMAIL_JA_CADASTRADO', async () => {
    const conta = await http.cadastrar();
    const r = await http.post('/v1/auth/cadastro', {
      nome: 'Outra', email: conta.email.toUpperCase(), senha: SENHA_BOA, objetivo: 'ar', aceitouTermos: true,
    });
    assert.equal(r.status, 409);
    assert.equal(r.corpo.erro.codigo, 'EMAIL_JA_CADASTRADO');
    assert.equal(r.corpo.erro.mensagem, 'Já existe uma conta com esse e-mail.');
  });

  it('telefone repetido responde 409 TELEFONE_JA_CADASTRADO', async () => {
    const telefone = telefoneUnico();
    await http.cadastrar({ telefone });
    const r = await http.post('/v1/auth/cadastro', {
      nome: 'Outra', email: emailUnico(), telefone, senha: SENHA_BOA, objetivo: 'ar', aceitouTermos: true,
    });
    assert.equal(r.status, 409);
    assert.equal(r.corpo.erro.codigo, 'TELEFONE_JA_CADASTRADO');
  });

  it('cadastro que falha no meio não deixa nada pela metade (transação)', async () => {
    const telefone = telefoneUnico();
    await http.cadastrar({ telefone });
    const email = emailUnico();
    await http.post('/v1/auth/cadastro', { nome: 'X', email, telefone, senha: SENHA_BOA, objetivo: 'ar', aceitouTermos: true });
    const sobra = await um(amb.admin, `SELECT count(*)::int AS n FROM refined.usuario WHERE email = $1`, [email]);
    assert.equal(sobra.n, 0);
  });

  describe('validação (422 VALIDACAO)', () => {
    const base = () => ({
      nome: 'Ana', email: emailUnico(), senha: SENHA_BOA, objetivo: 'ar', aceitouTermos: true,
    });
    const falha = async (mudanca: Record<string, unknown>) => {
      const r = await http.post('/v1/auth/cadastro', { ...base(), ...mudanca });
      assert.equal(r.status, 422, JSON.stringify(r.corpo));
      assert.equal(r.corpo.erro.codigo, 'VALIDACAO');
      return r.corpo.erro;
    };

    it('senha sem o requisito: a mensagem é a do front, campo a campo', async () => {
      const casos: [string, string][] = [
        ['Ab1!', 'A senha não atende a um requisito: mínimo de 8 caracteres.'],
        ['purifica@2025', 'A senha não atende a um requisito: letra maiúscula e minúscula.'],
        ['PURIFICA@2025', 'A senha não atende a um requisito: letra maiúscula e minúscula.'],
        ['Purifica@abcd', 'A senha não atende a um requisito: pelo menos um número.'],
        ['Purifica2025', 'A senha não atende a um requisito: um caractere especial (!@#$).'],
      ];
      for (const [senha, mensagem] of casos) {
        const erro = await falha({ senha });
        assert.equal(erro.mensagem, mensagem, senha);
        assert.equal(erro.campos.senha, mensagem);
      }
    });

    it('senha acima de 128 caracteres', async () => {
      const erro = await falha({ senha: `Aa1!${'x'.repeat(125)}` });
      assert.equal(erro.mensagem, 'A senha pode ter no máximo 128 caracteres.');
      const ok = await http.post('/v1/auth/cadastro', { ...base(), senha: `Aa1!${'x'.repeat(124)}` });
      assert.equal(ok.status, 201);
    });

    it('sem aceitar os termos', async () => {
      assert.equal((await falha({ aceitouTermos: false })).mensagem, 'É preciso aceitar os Termos de Uso.');
      assert.equal((await falha({ aceitouTermos: undefined })).campos.aceitouTermos, 'É preciso aceitar os Termos de Uso.');
    });

    it('nome, e-mail, telefone e objetivo inválidos', async () => {
      assert.equal((await falha({ nome: '   ' })).mensagem, 'Nome e e-mail são obrigatórios.');
      assert.equal((await falha({ email: 'sem-arroba' })).campos.email, 'Informe um e-mail válido.');
      assert.equal((await falha({ telefone: '123' })).campos.telefone, 'Informe um telefone válido, com DDD.');
      assert.equal((await falha({ objetivo: 'Monitoramento de ar e poluentes' })).campos.objetivo, 'Escolha um objetivo válido.');
    });

    it('vários erros juntos: `campos` traz todos e `mensagem` o primeiro na ordem da tela', async () => {
      const erro = await falha({ nome: '', email: 'x', senha: '1', aceitouTermos: false });
      assert.deepEqual(Object.keys(erro.campos).sort(), ['aceitouTermos', 'email', 'nome', 'senha']);
      assert.equal(erro.mensagem, erro.campos.nome);
    });

    it('telefone aceita máscara, DDD sem país e número internacional', async () => {
      const casos: [string, string][] = [
        ['11987654321', '+5511987654321'],
        ['(41) 3333-4444', '+554133334444'],
        ['+55 (11) 98765-4321', '+5511987654321'],
        ['5511987654321', '+5511987654321'],
        ['+351 912 345 678', '+351912345678'],
      ];
      for (const [entrada, esperado] of casos) {
        // Cada caso ocupa um número único de telefone: derruba o anterior para não colidir.
        await amb.admin.query(`UPDATE refined.usuario SET telefone = NULL WHERE telefone = $1`, [esperado]);
        const r = await http.post('/v1/auth/cadastro', { ...base(), telefone: entrada });
        assert.equal(r.status, 201, `${entrada}: ${JSON.stringify(r.corpo)}`);
        assert.equal(r.corpo.usuario.telefone, esperado, entrada);
      }
    });

    it('corpo que não é JSON ou grande demais', async () => {
      const ruim = await amb.app.fastify.inject({
        method: 'POST', url: '/v1/auth/cadastro', headers: { 'content-type': 'application/json' }, payload: '{nao e json',
      });
      assert.equal(ruim.statusCode, 422);
      assert.equal(JSON.parse(ruim.body).erro.codigo, 'VALIDACAO');
      const grande = await http.post('/v1/auth/cadastro', { ...base(), nome: 'x'.repeat(20_000) });
      assert.equal(grande.status, 413);
    });
  });
});
