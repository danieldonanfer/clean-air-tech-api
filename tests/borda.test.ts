import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { SENHA_BOA, api, emailUnico, iniciar, type Ambiente } from './_ambiente.ts';

describe('borda da API: CORS, cabeçalhos e rotas', () => {
  let amb: Ambiente;
  let http: ReturnType<typeof api>;
  before(async () => {
    amb = await iniciar({ CORS_ORIGINS: 'https://app.exemplo.org' });
    http = api(amb);
  });
  after(() => amb.fechar());

  const preflight = (origem: string) =>
    http.chamar('OPTIONS', '/v1/auth/login', {
      headers: {
        origin: origem,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });

  it('GET /saude responde { ok: true }', async () => {
    const r = await http.get('/saude');
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo, { ok: true });
  });

  it('origens do front e a de CORS_ORIGINS passam no preflight', async () => {
    const origens = [
      'https://danieldonanfer.github.io',
      'http://localhost:8081',
      'http://localhost:19006',
      'https://app.exemplo.org',
    ];
    for (const origem of origens) {
      const r = await preflight(origem);
      assert.equal(r.status, 204, origem);
      assert.equal(r.headers['access-control-allow-origin'], origem);
      assert.match(String(r.headers['access-control-allow-headers']), /authorization/i);
    }
  });

  it('origem desconhecida não recebe cabeçalho CORS (o navegador bloqueia)', async () => {
    const r = await preflight('https://site-malicioso.example');
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const comum = await http.chamar('GET', '/saude', { headers: { origin: 'https://site-malicioso.example' } });
    assert.equal(comum.headers['access-control-allow-origin'], undefined);
  });

  it('a API não aceita credenciais por cookie (sem Allow-Credentials)', async () => {
    const r = await preflight('https://danieldonanfer.github.io');
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
  });

  it('helmet: cabeçalhos de segurança e sem identificar o servidor', async () => {
    const r = await http.get('/saude');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.headers['strict-transport-security']);
    assert.equal(r.headers['x-powered-by'], undefined);
  });

  it('rota inexistente: 404 NAO_ENCONTRADO no formato de erro', async () => {
    const r = await http.get('/v1/nao-existe');
    assert.equal(r.status, 404);
    assert.equal(r.corpo.erro.codigo, 'NAO_ENCONTRADO');
  });

  it('o erro interno não vaza detalhes: 500 ERRO_INTERNO genérico', async () => {
    const ruim = await iniciar({ DATABASE_URL: 'postgres://nao:existe@127.0.0.1:1/nada' });
    try {
      const r = await api(ruim).post('/v1/auth/login', { email: emailUnico(), senha: SENHA_BOA });
      assert.equal(r.status, 500);
      assert.equal(r.corpo.erro.codigo, 'ERRO_INTERNO');
      assert.equal(r.corpo.erro.mensagem, 'Não foi possível concluir agora. Tente novamente em instantes.');
      assert.ok(!/postgres|ECONN|127\.0\.0\.1|nao:existe/i.test(JSON.stringify(r.corpo)));
    } finally {
      await ruim.fechar();
    }
  });

  it('limite global de requisições: 429 no mesmo formato de erro', async () => {
    const limitado = await iniciar({ LIMITE_GLOBAL_POR_MINUTO: '3' });
    try {
      const h = api(limitado);
      for (let i = 0; i < 3; i++) assert.equal((await h.get('/saude')).status, 200);
      const r = await h.get('/saude');
      assert.equal(r.status, 429);
      assert.equal(r.corpo.erro.codigo, 'MUITAS_REQUISICOES');
      assert.ok(Number(r.headers['retry-after']) >= 1);
    } finally {
      await limitado.fechar();
    }
  });
});

describe('nenhum segredo vaza', () => {
  let amb: Ambiente;
  let http: ReturnType<typeof api>;
  before(async () => {
    amb = await iniciar();
    http = api(amb);
  });
  after(() => amb.fechar());

  it('senha, token, código, hashes e e-mail não aparecem nos logs nem nas respostas', async () => {
    const senhaNova = 'NovaSenha@2026';
    const respostas: string[] = [];
    const guardar = (r: { corpo: unknown }) => respostas.push(JSON.stringify(r.corpo));

    const conta = await http.cadastrar({ nome: 'Pessoa Reservada' });
    const login = await http.post('/v1/auth/login', { email: conta.email, senha: conta.senha });
    guardar(login);
    guardar(await http.post('/v1/auth/login', { email: conta.email, senha: 'Errada@12345' }));
    guardar(await http.get('/v1/auth/eu', conta.token));
    guardar(await http.post('/v1/auth/recuperacao/solicitar', { email: conta.email }));
    for (let i = 0; i < 50 && amb.mailer.enviados.length === 0; i++) await new Promise((x) => setTimeout(x, 10));
    const codigo = amb.mailer.ultimoCodigo(conta.email);
    guardar(await http.post('/v1/auth/recuperacao/conferir', { email: conta.email, codigo: '000000' }));
    guardar(await http.post('/v1/auth/recuperacao/redefinir', { email: conta.email, codigo, senha: senhaNova }));
    guardar(await http.post('/v1/auth/logout', undefined, login.corpo.token));

    // Hashes que ficaram no banco: também não podem aparecer em log nem em resposta.
    const hashes = await amb.admin.query(
      `SELECT s.token_hash, t.token_hash AS codigo_hash, u.senha_hash
         FROM refined.usuario u
         LEFT JOIN refined.sessao_autenticacao s ON s.usuario_id = u.id
         LEFT JOIN refined.token_verificacao t ON t.usuario_id = u.id
        WHERE u.email = $1`,
      [conta.email],
    );
    const valoresDosHashes = hashes.rows.flatMap((linha) => Object.values<string | null>(linha)).filter((v): v is string => Boolean(v));

    const logs = amb.logs.join('\n');
    assert.ok(logs.includes('requisicao'), 'a API deveria ter registrado as requisições');
    const naoPodeVazar = [conta.senha, senhaNova, 'Errada@12345', conta.token, login.corpo.token, codigo, conta.email, ...valoresDosHashes];
    for (const segredo of naoPodeVazar) {
      assert.ok(!logs.includes(segredo), `vazou nos logs: ${segredo.slice(0, 6)}…`);
    }

    // Nas respostas o e-mail do próprio usuário e o token da sessão são esperados; o resto, nunca.
    const textoRespostas = respostas.join('\n');
    for (const proibido of [conta.senha, senhaNova, 'Errada@12345', codigo, ...valoresDosHashes]) {
      assert.ok(!textoRespostas.includes(proibido), `vazou na resposta: ${proibido.slice(0, 6)}…`);
    }
    assert.ok(!/argon2|senha_hash|token_hash/.test(textoRespostas));
  });

  it('os logs não levam IP, URL com parâmetros, corpo ou cabeçalhos', async () => {
    await http.chamar('POST', '/v1/auth/login', {
      corpo: { email: emailUnico(), senha: SENHA_BOA },
      headers: {
        'user-agent': 'agente-secreto/9.9',
        authorization: 'Bearer segredo-no-cabecalho',
        'x-forwarded-for': '203.0.113.7',
      },
    });
    const logs = amb.logs.join('\n');
    assert.ok(!logs.includes('agente-secreto'));
    assert.ok(!logs.includes('segredo-no-cabecalho'));
    assert.ok(!logs.includes('203.0.113.7'));
    assert.ok(!logs.includes('127.0.0.1'));
  });
});

describe('banco: o papel de login da API falha fechado', () => {
  it('sem SET ROLE o papel de login não lê nada (NOINHERIT), e o app não vê o hash da senha', async () => {
    const c = new pg.Client({ connectionString: process.env.API_DATABASE_URL });
    await c.connect();
    try {
      await assert.rejects(c.query(`SELECT count(*) FROM refined.usuario`), { code: '42501' });

      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE clean_air_app');
      // Sem app.usuario_id a RLS não mostra ninguém (falha fechada).
      assert.equal((await c.query(`SELECT count(*)::int AS n FROM refined.usuario`)).rows[0].n, 0);
      await c.query('ROLLBACK');

      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE clean_air_app');
      await assert.rejects(c.query(`SELECT senha_hash FROM refined.usuario`), { code: '42501' });
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  });

  it('o papel de login não é superusuário, nem cria papéis ou bancos, nem ignora a RLS', async () => {
    const c = new pg.Client({ connectionString: process.env.API_DATABASE_URL });
    await c.connect();
    try {
      const { rows } = await c.query(
        `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      assert.deepEqual(rows[0], { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    } finally {
      await c.end();
    }
  });
});
