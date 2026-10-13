import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { api, emailUnico, iniciar, um, type Ambiente } from './_ambiente.ts';

const NOVA_SENHA = 'NovaSenha@2026';

describe('recuperação de senha', () => {
  let amb: Ambiente;
  let http: ReturnType<typeof api>;
  before(async () => {
    amb = await iniciar();
    http = api(amb);
  });
  after(() => amb.fechar());

  const solicitar = (email: string) => http.post('/v1/auth/recuperacao/solicitar', { email });
  const conferir = (email: string, codigo: string) => http.post('/v1/auth/recuperacao/conferir', { email, codigo });
  const redefinir = (email: string, codigo: string, senha: string) =>
    http.post('/v1/auth/recuperacao/redefinir', { email, codigo, senha });
  const tokens = (email: string) =>
    amb.admin
      .query(
        `SELECT t.* FROM refined.token_verificacao t JOIN refined.usuario u ON u.id = t.usuario_id
          WHERE u.email = $1 AND t.tipo = 'recuperacao_senha' ORDER BY t.criado_em`,
        [email],
      )
      .then((r) => r.rows);

  /** Pede o código e espera o envio assíncrono chegar ao e-mail falso. */
  async function pedirCodigo(email: string): Promise<string> {
    const antes = amb.mailer.enviados.length;
    const r = await solicitar(email);
    assert.equal(r.status, 202);
    for (let i = 0; i < 50 && amb.mailer.enviados.length === antes; i++) await new Promise((x) => setTimeout(x, 10));
    return amb.mailer.ultimoCodigo(email);
  }
  const errado = (certo: string) => (certo === '000000' ? '111111' : '000000');

  it('solicitar: 202, código de 6 dígitos só por e-mail, nunca na resposta', async () => {
    const conta = await http.cadastrar({ nome: 'Carla Dias' });
    const r = await solicitar(conta.email);
    assert.equal(r.status, 202);
    assert.deepEqual(r.corpo, { expiraEmSegundos: 300 });

    const codigo = await pedirCodigo(conta.email);
    assert.match(codigo, /^\d{6}$/);
    const envio = amb.mailer.enviados.at(-1)!;
    assert.equal(envio.para.email, conta.email);
    assert.equal(envio.para.nome, 'Carla Dias');
    assert.ok(!JSON.stringify(r.corpo).includes(codigo));
  });

  it('no banco fica só o HMAC do código, com validade de 300 segundos', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    const [token] = (await tokens(conta.email)).slice(-1);
    assert.ok(token);
    assert.match(token.token_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(token.token_hash, codigo);
    assert.equal(token.tentativas_uso, 0);
    assert.equal(token.usado_em, null);
    const validade = await um(amb.admin, `SELECT extract(epoch FROM expira_em - criado_em)::int AS s FROM refined.token_verificacao WHERE id = $1`, [token.id]);
    assert.equal(validade.s, 300);
  });

  it('e-mail sem conta: resposta idêntica e nenhum e-mail enviado', async () => {
    const conta = await http.cadastrar();
    const enviadosAntes = amb.mailer.enviados.length;
    const existente = await solicitar(conta.email);
    const inexistente = await solicitar(emailUnico('fantasma'));
    assert.equal(inexistente.status, existente.status);
    assert.deepEqual(inexistente.corpo, existente.corpo);
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(amb.mailer.enviados.length, enviadosAntes + 1, 'só a conta real recebe e-mail');
  });

  it('o tempo do pedido não revela se a conta existe', async () => {
    const conta = await http.cadastrar();
    const medir = async (email: string) => {
      const inicio = process.hrtime.bigint();
      await solicitar(email);
      return Number(process.hrtime.bigint() - inicio) / 1e6;
    };
    const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const existente: number[] = [];
    const inexistente: number[] = [];
    for (let i = 0; i < 5; i++) {
      existente.push(await medir(conta.email));
      inexistente.push(await medir(emailUnico('fantasma')));
    }
    const razao = mediana(inexistente) / mediana(existente);
    assert.ok(razao > 0.6 && razao < 1.6, `existente ${mediana(existente)}ms, inexistente ${mediana(inexistente)}ms`);
  });

  it('conta suspensa não recebe código, mas a resposta é a mesma', async () => {
    const conta = await http.cadastrar();
    await amb.admin.query(`UPDATE refined.usuario SET status_conta = 'suspenso' WHERE email = $1`, [conta.email]);
    const antes = amb.mailer.enviados.length;
    assert.equal((await solicitar(conta.email)).status, 202);
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(amb.mailer.enviados.length, antes);
    assert.equal((await tokens(conta.email)).length, 0);
  });

  it('conferir: aceita o código certo quantas vezes quiser, sem consumi-lo', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    assert.equal((await conferir(conta.email, codigo)).status, 204);
    assert.equal((await conferir(conta.email, codigo)).status, 204);
    const [token] = (await tokens(conta.email)).slice(-1);
    assert.equal(token.usado_em, null);
    assert.equal(token.tentativas_uso, 0);
  });

  it('conferir: código errado dá 400 com a mensagem do front e conta uma tentativa', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    const r = await conferir(conta.email, errado(codigo));
    assert.equal(r.status, 400);
    assert.equal(r.corpo.erro.codigo, 'CODIGO_INVALIDO');
    assert.equal(r.corpo.erro.mensagem, 'Código inválido ou expirado.');
    assert.equal((await tokens(conta.email)).at(-1).tentativas_uso, 1);
  });

  it('código com formato errado ou e-mail sem conta: mesma resposta, sem 422', async () => {
    const conta = await http.cadastrar();
    await pedirCodigo(conta.email);
    for (const [email, codigo] of [[conta.email, 'abc'], [conta.email, '12345'], [emailUnico('fantasma'), '123456']] as const) {
      const r = await conferir(email, codigo);
      assert.equal(r.status, 400);
      assert.equal(r.corpo.erro.codigo, 'CODIGO_INVALIDO');
    }
  });

  it('fluxo completo: solicitar, conferir, redefinir, entrar com a nova senha', async () => {
    const conta = await http.cadastrar();
    const outraSessao = await http.post('/v1/auth/login', { email: conta.email, senha: conta.senha });
    const codigo = await pedirCodigo(conta.email);

    assert.equal((await conferir(conta.email, codigo)).status, 204);
    const r = await redefinir(conta.email, codigo, NOVA_SENHA);
    assert.equal(r.status, 204);

    assert.equal((await http.post('/v1/auth/login', { email: conta.email, senha: NOVA_SENHA })).status, 200);
    const antiga = await http.post('/v1/auth/login', { email: conta.email, senha: conta.senha });
    assert.equal(antiga.status, 401);
    assert.equal(antiga.corpo.erro.codigo, 'CREDENCIAIS_INVALIDAS');

    // Todas as sessões que existiam foram revogadas.
    assert.equal((await http.get('/v1/auth/eu', conta.token)).status, 401);
    assert.equal((await http.get('/v1/auth/eu', outraSessao.corpo.token)).status, 401);

    const u = await um(amb.admin, `SELECT senha_alterada_em, senha_hash FROM refined.usuario WHERE email = $1`, [conta.email]);
    assert.match(u.senha_hash, /^\$argon2id\$/);
  });

  it('o código é de uso único: depois de redefinir, não vale mais', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    assert.equal((await redefinir(conta.email, codigo, NOVA_SENHA)).status, 204);
    const de_novo = await redefinir(conta.email, codigo, 'OutraSenha@2026');
    assert.equal(de_novo.status, 400);
    assert.equal(de_novo.corpo.erro.codigo, 'CODIGO_INVALIDO');
    assert.equal((await conferir(conta.email, codigo)).status, 400);
    assert.equal((await http.post('/v1/auth/login', { email: conta.email, senha: NOVA_SENHA })).status, 200);
  });

  it('código expirado não vale', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    await amb.admin.query(
      `UPDATE refined.token_verificacao t
          SET criado_em = now() - interval '10 minutes', expira_em = now() - interval '5 minutes'
         FROM refined.usuario u WHERE u.id = t.usuario_id AND u.email = $1`,
      [conta.email],
    );
    assert.equal((await conferir(conta.email, codigo)).status, 400);
    assert.equal((await redefinir(conta.email, codigo, NOVA_SENHA)).status, 400);
    assert.equal((await http.post('/v1/auth/login', { email: conta.email, senha: conta.senha })).status, 200);
  });

  it('um pedido novo invalida o código anterior', async () => {
    const conta = await http.cadastrar();
    const primeiro = await pedirCodigo(conta.email);
    const segundo = await pedirCodigo(conta.email);
    assert.notEqual(primeiro, segundo);
    assert.equal((await conferir(conta.email, primeiro)).status, 400);
    assert.equal((await conferir(conta.email, segundo)).status, 204);
  });

  it('cinco tentativas erradas matam o código, mesmo que a sexta seja a certa', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    for (let i = 1; i <= 5; i++) {
      assert.equal((await conferir(conta.email, errado(codigo))).status, 400, `tentativa ${i}`);
    }
    const [token] = (await tokens(conta.email)).slice(-1);
    assert.equal(token.tentativas_uso, 5);
    assert.ok(token.usado_em, 'o código deve ficar inutilizado');
    assert.equal((await conferir(conta.email, codigo)).status, 400);
    assert.equal((await redefinir(conta.email, codigo, NOVA_SENHA)).status, 400);
  });

  it('tentativas erradas em `redefinir` também contam', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    for (let i = 0; i < 5; i++) assert.equal((await redefinir(conta.email, errado(codigo), NOVA_SENHA)).status, 400);
    assert.equal((await redefinir(conta.email, codigo, NOVA_SENHA)).status, 400);
  });

  it('senha fraca em `redefinir`: 422 e o código continua válido', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    const r = await redefinir(conta.email, codigo, 'fraca');
    assert.equal(r.status, 422);
    assert.equal(r.corpo.erro.codigo, 'VALIDACAO');
    assert.match(r.corpo.erro.campos.senha, /^A senha não atende a um requisito/);
    assert.equal((await redefinir(conta.email, codigo, NOVA_SENHA)).status, 204);
  });

  it('a recuperação NÃO usa o bloqueio de força bruta do login (regra OWASP)', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    for (let i = 0; i < 4; i++) await conferir(conta.email, errado(codigo));
    const u = await um(amb.admin, `SELECT tentativas_login_falhas, bloqueado_ate FROM refined.usuario WHERE email = $1`, [conta.email]);
    assert.equal(u.tentativas_login_falhas, 0);
    assert.equal(u.bloqueado_ate, null);
  });

  it('redefinir limpa o bloqueio do login: quem provou ser o dono volta a entrar', async () => {
    const conta = await http.cadastrar();
    for (let i = 0; i < 5; i++) await http.post('/v1/auth/login', { email: conta.email, senha: 'Errada@12345' });
    assert.equal((await http.post('/v1/auth/login', { email: conta.email, senha: conta.senha })).status, 423);
    const codigo = await pedirCodigo(conta.email);
    assert.equal((await redefinir(conta.email, codigo, NOVA_SENHA)).status, 204);
    assert.equal((await http.post('/v1/auth/login', { email: conta.email, senha: NOVA_SENHA })).status, 200);
  });

  it('o código não aparece em nenhuma tabela em texto, nem na auditoria', async () => {
    const conta = await http.cadastrar();
    const codigo = await pedirCodigo(conta.email);
    const achado = await amb.admin.query(
      `SELECT 1 FROM refined.log_auditoria WHERE dado_novo::text LIKE $1 OR dado_anterior::text LIKE $1`,
      [`%${codigo}%`],
    );
    assert.equal(achado.rowCount, 0);
  });
});

describe('recuperação de senha: limite de pedidos', () => {
  it('3 pedidos por hora por e-mail: o quarto é 429 com Retry-After', async () => {
    const amb = await iniciar({ RECUPERACAO_PEDIDOS_POR_HORA: '3' });
    try {
      const http = api(amb);
      const conta = await http.cadastrar();
      for (let i = 1; i <= 3; i++) {
        assert.equal((await http.post('/v1/auth/recuperacao/solicitar', { email: conta.email })).status, 202, `pedido ${i}`);
      }
      const r = await http.post('/v1/auth/recuperacao/solicitar', { email: conta.email });
      assert.equal(r.status, 429);
      assert.equal(r.corpo.erro.codigo, 'MUITAS_REQUISICOES');
      assert.equal(r.corpo.erro.mensagem, 'Muitas tentativas. Aguarde alguns minutos e tente de novo.');
      assert.ok(Number(r.headers['retry-after']) > 0);
    } finally {
      await amb.fechar();
    }
  });

  it('o limite vale também para e-mail sem conta (a resposta não pode revelar quem existe)', async () => {
    const amb = await iniciar({ RECUPERACAO_PEDIDOS_POR_HORA: '3' });
    try {
      const http = api(amb);
      const fantasma = emailUnico('fantasma');
      for (let i = 0; i < 3; i++) assert.equal((await http.post('/v1/auth/recuperacao/solicitar', { email: fantasma })).status, 202);
      assert.equal((await http.post('/v1/auth/recuperacao/solicitar', { email: fantasma })).status, 429);
    } finally {
      await amb.fechar();
    }
  });

  it('o limite também vale por IP, mesmo trocando de e-mail', async () => {
    const amb = await iniciar({ RECUPERACAO_PEDIDOS_POR_HORA: '3' });
    try {
      const http = api(amb);
      for (let i = 0; i < 3; i++) {
        assert.equal((await http.post('/v1/auth/recuperacao/solicitar', { email: emailUnico('a') })).status, 202);
      }
      assert.equal((await http.post('/v1/auth/recuperacao/solicitar', { email: emailUnico('b') })).status, 429);
    } finally {
      await amb.fechar();
    }
  });
});
