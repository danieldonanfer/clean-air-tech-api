import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, iniciar, um, type Ambiente } from './_ambiente.ts';

describe('sessão: GET /v1/auth/eu e POST /v1/auth/logout', () => {
  let amb: Ambiente;
  let http: ReturnType<typeof api>;
  before(async () => {
    amb = await iniciar();
    http = api(amb);
  });
  after(() => amb.fechar());

  const semSessao = (r: { status: number; corpo: any }) => {
    assert.equal(r.status, 401);
    assert.equal(r.corpo.erro.codigo, 'SESSAO_INVALIDA');
    assert.equal(r.corpo.erro.mensagem, 'Sua sessão expirou. Entre novamente.');
  };

  it('`eu` devolve o usuário da sessão (lido pelo papel clean_air_app, sob RLS)', async () => {
    const conta = await http.cadastrar({ nome: 'Beatriz Souza', objetivo: 'conforto' });
    const r = await http.get('/v1/auth/eu', conta.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo, { usuario: conta.usuario });
    assert.equal(r.corpo.usuario.objetivo, 'Conforto e automação');
  });

  it('sem token, com token lixo ou com esquema errado: 401 SESSAO_INVALIDA', async () => {
    semSessao(await http.get('/v1/auth/eu'));
    semSessao(await http.get('/v1/auth/eu', 'token-que-nao-existe'));
    const conta = await http.cadastrar();
    semSessao(await http.chamar('GET', '/v1/auth/eu', { headers: { authorization: `Basic ${conta.token}` } }));
    semSessao(await http.chamar('GET', '/v1/auth/eu', { headers: { authorization: `Bearer ${'x'.repeat(5000)}` } }));
  });

  it('token expirado deixa de valer', async () => {
    const conta = await http.cadastrar();
    assert.equal((await http.get('/v1/auth/eu', conta.token)).status, 200);
    await amb.admin.query(
      `UPDATE refined.sessao_autenticacao s
          SET criado_em = now() - interval '8 days', expira_em = now() - interval '1 day'
         FROM refined.usuario u
        WHERE u.id = s.usuario_id AND u.email = $1`,
      [conta.email],
    );
    semSessao(await http.get('/v1/auth/eu', conta.token));
  });

  it('logout revoga só a sessão usada: ela morre, as outras da conta continuam', async () => {
    const conta = await http.cadastrar();
    const segunda = await http.post('/v1/auth/login', { email: conta.email, senha: conta.senha });
    assert.equal(segunda.status, 200);

    const saida = await http.post('/v1/auth/logout', undefined, conta.token);
    assert.equal(saida.status, 204);
    assert.equal(saida.corpo, null);

    semSessao(await http.get('/v1/auth/eu', conta.token));
    assert.equal((await http.get('/v1/auth/eu', segunda.corpo.token)).status, 200);

    const s = await um(amb.admin, `SELECT revogado_em FROM refined.sessao_autenticacao s JOIN refined.usuario u ON u.id = s.usuario_id WHERE u.email = $1 ORDER BY s.criado_em LIMIT 1`, [conta.email]);
    assert.ok(s.revogado_em);
  });

  it('logout repetido ou sem sessão: 401', async () => {
    const conta = await http.cadastrar();
    assert.equal((await http.post('/v1/auth/logout', undefined, conta.token)).status, 204);
    semSessao(await http.post('/v1/auth/logout', undefined, conta.token));
    semSessao(await http.post('/v1/auth/logout'));
  });

  it('logout aceita Content-Type JSON com corpo vazio (como o front pode enviar)', async () => {
    const conta = await http.cadastrar();
    const r = await http.chamar('POST', '/v1/auth/logout', {
      token: conta.token,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(r.status, 204);
  });

  it('conta suspensa ou excluída perde a sessão na hora', async () => {
    const suspensa = await http.cadastrar();
    await amb.admin.query(`UPDATE refined.usuario SET status_conta = 'suspenso' WHERE email = $1`, [suspensa.email]);
    semSessao(await http.get('/v1/auth/eu', suspensa.token));

    const excluida = await http.cadastrar();
    await amb.admin.query(`UPDATE refined.usuario SET removido_em = now() WHERE email = $1`, [excluida.email]);
    semSessao(await http.get('/v1/auth/eu', excluida.token));
  });
});
