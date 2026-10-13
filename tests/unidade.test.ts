import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { carregarConfig } from '../src/config.ts';
import { criarMailer, montarMensagem, separarRemetente } from '../src/email.ts';
import { Limitador } from '../src/limitador.ts';
import { criarSeguranca } from '../src/seguranca.ts';
import { normalizarTelefone, problemaDaSenha } from '../src/validacao.ts';

const AMBIENTE_MINIMO = { DATABASE_URL: 'postgres://x', SEGREDO_CODIGOS: 'x'.repeat(40) };
const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres';

describe('configuração', () => {
  it('aplica os padrões e junta as origens do front com as de CORS_ORIGINS', () => {
    const c = carregarConfig({ ...AMBIENTE_MINIMO, CORS_ORIGINS: ' https://a.com , https://b.com ,' });
    assert.equal(c.PORT, 3000);
    assert.equal(c.SESSAO_DIAS, 7);
    assert.equal(c.RECUPERACAO_PEDIDOS_POR_HORA, 3);
    assert.ok(c.origensPermitidas.includes('https://danieldonanfer.github.io'));
    assert.ok(c.origensPermitidas.includes('https://a.com'));
    assert.ok(c.origensPermitidas.includes('https://b.com'));
  });

  it('recusa configuração incompleta sem mostrar os valores', () => {
    assert.throws(() => carregarConfig({}), (e: Error) => /DATABASE_URL/.test(e.message) && /SEGREDO_CODIGOS/.test(e.message));
    assert.throws(
      () => carregarConfig({ DATABASE_URL: 'postgres://usuario:senha-secreta@h/db', SEGREDO_CODIGOS: 'curto' }),
      (e: Error) => !e.message.includes('senha-secreta') && /SEGREDO_CODIGOS/.test(e.message),
    );
  });

  it('em produção o e-mail de console é proibido e o SMTP exige host', () => {
    assert.throws(() => carregarConfig({ ...AMBIENTE_MINIMO, NODE_ENV: 'production' }), /EMAIL_MODE/);
    assert.throws(() => carregarConfig({ ...AMBIENTE_MINIMO, NODE_ENV: 'production', EMAIL_MODE: 'smtp' }), /SMTP_HOST/);
    assert.doesNotThrow(() =>
      carregarConfig({ ...AMBIENTE_MINIMO, NODE_ENV: 'production', EMAIL_MODE: 'smtp', SMTP_HOST: 'smtp.exemplo.com' }),
    );
  });
});

describe('e-mail pelo Brevo (API HTTPS)', () => {
  const REGISTRO = { info() {}, error() {} };
  const CONFIG = carregarConfig({
    ...AMBIENTE_MINIMO,
    NODE_ENV: 'production',
    EMAIL_MODE: 'brevo',
    BREVO_API_KEY: 'xkeysib-chave-de-teste',
    EMAIL_FROM: 'Clean Air Tech <remetente@exemplo.com>',
  });

  it('exige a chave e aceita o modo brevo em produção', () => {
    assert.throws(
      () => carregarConfig({ ...AMBIENTE_MINIMO, NODE_ENV: 'production', EMAIL_MODE: 'brevo' }),
      (e: Error) => /BREVO_API_KEY/.test(e.message),
    );
    assert.equal(CONFIG.EMAIL_MODE, 'brevo');
  });

  it('separa o remetente "Nome <email>" e o e-mail puro', () => {
    assert.deepEqual(separarRemetente('Clean Air Tech <a@b.com>'), { name: 'Clean Air Tech', email: 'a@b.com' });
    assert.deepEqual(separarRemetente('"Clean Air" <a@b.com>'), { name: 'Clean Air', email: 'a@b.com' });
    assert.deepEqual(separarRemetente('<a@b.com>'), { email: 'a@b.com' });
    assert.deepEqual(separarRemetente(' a@b.com '), { email: 'a@b.com' });
  });

  it('envia pela API: URL, chave no cabeçalho, remetente, destinatário e código', async () => {
    let chamada: { url: string; init: RequestInit } | undefined;
    const buscar = (async (url: string, init: RequestInit) => {
      chamada = { url, init };
      return new Response(JSON.stringify({ messageId: 'x' }), { status: 201 });
    }) as unknown as typeof fetch;

    await criarMailer(CONFIG, REGISTRO, buscar).enviarCodigoRecuperacao({ email: 'ana@exemplo.com', nome: 'Ana Silva' }, '123456');

    assert.equal(chamada?.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(chamada?.init.method, 'POST');
    const cabecalhos = chamada?.init.headers as Record<string, string>;
    assert.equal(cabecalhos['api-key'], 'xkeysib-chave-de-teste');
    const corpo = JSON.parse(String(chamada?.init.body));
    assert.deepEqual(corpo.sender, { name: 'Clean Air Tech', email: 'remetente@exemplo.com' });
    assert.deepEqual(corpo.to, [{ email: 'ana@exemplo.com', name: 'Ana Silva' }]);
    assert.match(corpo.subject, /123456/);
    assert.match(corpo.htmlContent, /123456/);
    assert.match(corpo.textContent, /123456/);
  });

  it('falha com o motivo do Brevo, sem vazar a chave', async () => {
    const buscar = (async () =>
      new Response(JSON.stringify({ code: 'invalid_parameter', message: 'Sender not valid' }), { status: 400 })) as unknown as typeof fetch;
    const mailer = criarMailer(CONFIG, REGISTRO, buscar);
    await assert.rejects(
      () => mailer.enviarCodigoRecuperacao({ email: 'ana@exemplo.com', nome: 'Ana' }, '123456'),
      (e: Error) => /400/.test(e.message) && /Sender not valid/.test(e.message) && !e.message.includes('xkeysib'),
    );
  });

  it('erro de rede também sobe, para a API registrar no log', async () => {
    const buscar = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await assert.rejects(() =>
      criarMailer(CONFIG, REGISTRO, buscar).enviarCodigoRecuperacao({ email: 'ana@exemplo.com', nome: 'Ana' }, '123456'),
    );
  });
});

describe('segurança', () => {
  const seg = criarSeguranca({ ARGON2_MEMORIA_KIB: 1024, SEGREDO_CODIGOS: SEGREDO });

  it('hash argon2id, diferente a cada vez, e a conferência aceita só a senha certa', async () => {
    const a = await seg.hashSenha('Purifica@2025');
    const b = await seg.hashSenha('Purifica@2025');
    assert.match(a, /^\$argon2id\$/);
    assert.notEqual(a, b);
    assert.equal(await seg.conferirSenha(a, 'Purifica@2025'), true);
    assert.equal(await seg.conferirSenha(a, 'purifica@2025'), false);
    assert.equal(await seg.conferirSenha('isto-nao-e-um-hash', 'Purifica@2025'), false);
  });

  it('token de sessão: 32 bytes em base64url, únicos, e o hash é o SHA-256', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => seg.novoTokenSessao().token));
    assert.equal(tokens.size, 200);
    const { token, hash } = seg.novoTokenSessao();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hash, seg.hashTokenSessao(token));
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('código: 6 dígitos com zeros à esquerda; o HMAC depende do usuário e do código', () => {
    for (let i = 0; i < 500; i++) assert.match(seg.novoCodigo(), /^\d{6}$/);
    const h = seg.hashCodigo('u1', 'recuperacao_senha', '123456');
    assert.equal(h, seg.hashCodigo('u1', 'recuperacao_senha', '123456'));
    assert.notEqual(h, seg.hashCodigo('u2', 'recuperacao_senha', '123456'));
    assert.notEqual(h, seg.hashCodigo('u1', 'recuperacao_senha', '123457'));
    assert.equal(seg.hashesIguais(h, h), true);
    assert.equal(seg.hashesIguais(h, 'curto'), false);
  });

  it('a chave do HMAC muda o resultado (o banco sozinho não basta para refazer um código)', () => {
    const outra = criarSeguranca({ ARGON2_MEMORIA_KIB: 1024, SEGREDO_CODIGOS: 'outro-segredo-tambem-com-mais-de-32-chars' });
    assert.notEqual(
      seg.hashCodigo('u1', 'recuperacao_senha', '123456'),
      outra.hashCodigo('u1', 'recuperacao_senha', '123456'),
    );
  });
});

describe('limitador', () => {
  it('libera até o máximo e depois informa quantos segundos faltam', () => {
    let agora = 0;
    const l = new Limitador(3, 60_000, () => agora);
    assert.equal(l.tentar('a'), null);
    assert.equal(l.tentar('a'), null);
    assert.equal(l.tentar('a'), null);
    assert.equal(l.tentar('a'), 60);
    agora = 30_000;
    assert.equal(l.tentar('a'), 30);
    assert.equal(l.tentar('b'), null, 'cada chave tem a sua janela');
  });

  it('a janela desliza: tentativas antigas deixam de contar', () => {
    let agora = 0;
    const l = new Limitador(2, 1000, () => agora);
    l.tentar('a');
    agora = 600;
    l.tentar('a');
    assert.notEqual(l.tentar('a'), null);
    agora = 1100; // a primeira (t=0) saiu da janela
    assert.equal(l.tentar('a'), null);
  });
});

describe('validação', () => {
  it('senha: devolve o primeiro requisito não atendido, na ordem do front', () => {
    assert.equal(problemaDaSenha('Purifica@2025'), null);
    assert.equal(problemaDaSenha('abc'), 'A senha não atende a um requisito: mínimo de 8 caracteres.');
    assert.equal(problemaDaSenha('abcdefgh'), 'A senha não atende a um requisito: letra maiúscula e minúscula.');
    assert.equal(problemaDaSenha('Abcdefgh'), 'A senha não atende a um requisito: pelo menos um número.');
    assert.equal(problemaDaSenha('Abcdefg1'), 'A senha não atende a um requisito: um caractere especial (!@#$).');
    assert.equal(problemaDaSenha(`Aa1!${'x'.repeat(125)}`), 'A senha pode ter no máximo 128 caracteres.');
  });

  it('telefone: normaliza para E.164 ou rejeita', () => {
    assert.equal(normalizarTelefone(''), null);
    assert.equal(normalizarTelefone('   '), null);
    assert.equal(normalizarTelefone('(11) 98765-4321'), '+5511987654321');
    assert.equal(normalizarTelefone('55 11 98765-4321'), '+5511987654321');
    assert.equal(normalizarTelefone('+1 (415) 555-2671'), '+14155552671');
    for (const ruim of ['123', 'abc', '+0123456789', '119876543']) {
      assert.throws(() => normalizarTelefone(ruim), /telefone válido/);
    }
  });
});

describe('e-mail de recuperação', () => {
  it('traz o código, a validade e o primeiro nome, e escapa HTML no nome', () => {
    const m = montarMensagem({ email: 'a@b.com', nome: '<script>alert(1)</script> Silva' }, '042913');
    assert.match(m.assunto, /042913/);
    assert.match(m.texto, /042913/);
    assert.match(m.texto, /5 minutos/);
    assert.match(m.html, /042913/);
    assert.ok(!m.html.includes('<script>'));
  });
});
