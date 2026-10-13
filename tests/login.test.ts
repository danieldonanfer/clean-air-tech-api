import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SENHA_BOA, api, emailUnico, iniciar, um, type Ambiente } from './_ambiente.ts';

describe('POST /v1/auth/login', () => {
  let amb: Ambiente;
  let http: ReturnType<typeof api>;
  before(async () => {
    amb = await iniciar();
    http = api(amb);
  });
  after(() => amb.fechar());

  const entrar = (email: string, senha: string) => http.post('/v1/auth/login', { email, senha });

  it('entra com e-mail e senha corretos e devolve token e usuário', async () => {
    const conta = await http.cadastrar();
    const r = await entrar(conta.email, conta.senha);
    assert.equal(r.status, 200);
    assert.match(r.corpo.token, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(r.corpo.token, conta.token, 'cada login abre uma sessão nova');
    assert.deepEqual(r.corpo.usuario, conta.usuario);

    const u = await um(amb.admin, `SELECT ultimo_login_em, tentativas_login_falhas FROM refined.usuario WHERE email = $1`, [conta.email]);
    assert.ok(u.ultimo_login_em);
    assert.equal(u.tentativas_login_falhas, 0);
  });

  it('o e-mail não diferencia maiúsculas e minúsculas, nem espaços nas pontas', async () => {
    const conta = await http.cadastrar();
    const r = await entrar(`  ${conta.email.toUpperCase()} `, conta.senha);
    assert.equal(r.status, 200);
  });

  it('senha errada e e-mail inexistente dão exatamente a mesma resposta', async () => {
    const conta = await http.cadastrar();
    const errada = await entrar(conta.email, 'Errada@12345');
    const inexistente = await entrar(emailUnico('naoexiste'), 'Errada@12345');
    assert.equal(errada.status, 401);
    assert.equal(inexistente.status, 401);
    assert.deepEqual(errada.corpo, inexistente.corpo);
    assert.equal(errada.corpo.erro.codigo, 'CREDENCIAIS_INVALIDAS');
    assert.equal(errada.corpo.erro.mensagem, 'E-mail ou senha incorretos.');
  });

  it('a conta inexistente também passa pelo cálculo do hash (o tempo não revela o e-mail)', async () => {
    const conta = await http.cadastrar();
    const medir = async (email: string) => {
      const inicio = process.hrtime.bigint();
      await entrar(email, 'Errada@12345');
      return Number(process.hrtime.bigint() - inicio) / 1e6;
    };
    await medir(conta.email);
    await medir(emailUnico('nao'));
    // Várias rodadas e a mediana: uma amostra só oscilaria demais.
    const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const existente: number[] = [];
    const inexistente: number[] = [];
    for (let i = 0; i < 5; i++) {
      existente.push(await medir(conta.email));
      inexistente.push(await medir(emailUnico('nao')));
      // Reinicia o contador para a conta real não chegar ao bloqueio durante a medição.
      await amb.admin.query(`UPDATE refined.usuario SET tentativas_login_falhas = 0, bloqueado_ate = NULL WHERE email = $1`, [conta.email]);
    }
    const razao = mediana(inexistente) / mediana(existente);
    assert.ok(razao > 0.4 && razao < 2.5, `tempos muito diferentes: existente ${mediana(existente)}ms, inexistente ${mediana(inexistente)}ms`);
  });

  it('cinco falhas seguidas bloqueiam o login por 15 minutos, até com a senha certa', async () => {
    const conta = await http.cadastrar();
    for (let i = 1; i <= 5; i++) {
      const r = await entrar(conta.email, 'Errada@12345');
      assert.equal(r.status, 401, `tentativa ${i}`);
    }
    const bloqueada = await entrar(conta.email, conta.senha);
    assert.equal(bloqueada.status, 423);
    assert.equal(bloqueada.corpo.erro.codigo, 'CONTA_BLOQUEADA');
    assert.match(bloqueada.corpo.erro.mensagem, /Tente novamente em 15 minutos\.$/);

    const u = await um(amb.admin, `SELECT bloqueado_ate - now() AS resta FROM refined.usuario WHERE email = $1`, [conta.email]);
    assert.ok(u.resta.minutes >= 14 && u.resta.minutes <= 15, JSON.stringify(u.resta));

    // Passado o prazo, a senha certa volta a funcionar e o contador recomeça do zero.
    await amb.admin.query(`UPDATE refined.usuario SET bloqueado_ate = now() - interval '1 second' WHERE email = $1`, [conta.email]);
    const livre = await entrar(conta.email, conta.senha);
    assert.equal(livre.status, 200);
    const depois = await um(amb.admin, `SELECT tentativas_login_falhas, bloqueado_ate FROM refined.usuario WHERE email = $1`, [conta.email]);
    assert.equal(depois.tentativas_login_falhas, 0);
    assert.equal(depois.bloqueado_ate, null);
  });

  it('o sucesso zera o contador: falhas espaçadas por um acerto não bloqueiam', async () => {
    const conta = await http.cadastrar();
    for (let i = 0; i < 4; i++) await entrar(conta.email, 'Errada@12345');
    assert.equal((await entrar(conta.email, conta.senha)).status, 200);
    for (let i = 0; i < 4; i++) {
      assert.equal((await entrar(conta.email, 'Errada@12345')).status, 401);
    }
  });

  it('conta suspensa: senha errada continua 401, senha certa revela 403', async () => {
    const conta = await http.cadastrar();
    await amb.admin.query(`UPDATE refined.usuario SET status_conta = 'suspenso' WHERE email = $1`, [conta.email]);
    assert.equal((await entrar(conta.email, 'Errada@12345')).status, 401);
    const r = await entrar(conta.email, conta.senha);
    assert.equal(r.status, 403);
    assert.equal(r.corpo.erro.codigo, 'CONTA_SUSPENSA');
  });

  it('conta excluída responde como credencial inválida', async () => {
    const conta = await http.cadastrar();
    await amb.admin.query(`UPDATE refined.usuario SET removido_em = now() WHERE email = $1`, [conta.email]);
    const r = await entrar(conta.email, conta.senha);
    assert.equal(r.status, 401);
    assert.equal(r.corpo.erro.codigo, 'CREDENCIAIS_INVALIDAS');
  });

  it('exige e-mail e senha preenchidos (422)', async () => {
    const r = await http.post('/v1/auth/login', { email: 'sem-arroba', senha: '' });
    assert.equal(r.status, 422);
    assert.equal(r.corpo.erro.codigo, 'VALIDACAO');
    assert.ok(r.corpo.erro.campos.email);
    assert.ok(r.corpo.erro.campos.senha);
  });

  it('a senha nunca volta na resposta nem aparece em campo algum', async () => {
    const conta = await http.cadastrar();
    const r = await entrar(conta.email, SENHA_BOA);
    const texto = JSON.stringify(r.corpo);
    assert.ok(!texto.includes(SENHA_BOA));
    assert.ok(!/senha|hash|argon/i.test(texto));
  });
});
