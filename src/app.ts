import { Writable } from 'node:stream';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { LogController, type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { criarServicoAuth, type ServicoAuth, type SessaoAutenticada } from './auth.ts';
import type { Config } from './config.ts';
import { criarBanco, type Banco } from './db.ts';
import { criarMailer, type Mailer } from './email.ts';
import { ErroApi, erros } from './erros.ts';
import { criarSeguranca, type Seguranca } from './seguranca.ts';
import {
  esquemaCadastro,
  esquemaCodigo,
  esquemaEmail,
  esquemaLogin,
  esquemaRedefinicao,
  validar,
} from './validacao.ts';

declare module 'fastify' {
  interface FastifyRequest {
    sessao?: SessaoAutenticada;
  }
}

export interface OpcoesApp {
  config: Config;
  /** Troca o envio de e-mail (os testes capturam o código em vez de enviar). */
  mailer?: Mailer;
  /** Destino dos logs; os testes usam para provar que nenhum segredo vaza. */
  logStream?: Writable;
}

export interface App {
  fastify: FastifyInstance;
  db: Banco;
  seg: Seguranca;
  auth: ServicoAuth;
}

const LIMITE_CORPO_BYTES = 16 * 1024;

function tokenDoCabecalho(req: FastifyRequest): string | null {
  const cabecalho = req.headers.authorization;
  if (!cabecalho) return null;
  const [esquema, token] = cabecalho.split(' ');
  return esquema?.toLowerCase() === 'bearer' && token ? token : null;
}

export async function criarApp({ config, mailer, logStream }: OpcoesApp): Promise<App> {
  const fastify = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(logStream ? { stream: logStream } : {}),
      // Cabeçalhos e corpo nunca entram no log (senha, token, código).
      redact: ['req.headers', 'res.headers'],
    },
    // O log de requisição padrão leva IP e URL; o próprio log abaixo guarda só o necessário.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: LIMITE_CORPO_BYTES,
  });

  const db = criarBanco(config);
  const seg = criarSeguranca(config);
  const auth = criarServicoAuth({
    db,
    seg,
    config,
    log: fastify.log,
    mailer: mailer ?? criarMailer(config, fastify.log),
  });

  // JSON: corpo vazio vira {} (o logout do front pode mandar o cabeçalho sem corpo).
  fastify.removeContentTypeParser('application/json');
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, corpo, pronto) => {
    const texto = String(corpo).trim();
    if (!texto) return pronto(null, {});
    try {
      pronto(null, JSON.parse(texto));
    } catch {
      pronto(erros.validacao('Corpo da requisição inválido.', { corpo: 'Corpo da requisição inválido.' }));
    }
  });

  await fastify.register(helmet);
  await fastify.register(cors, {
    // Sem cabeçalho Origin (curl, servidor a servidor) passa; navegador só de origem listada.
    origin: (origem, retorno) => retorno(null, !origem || config.origensPermitidas.includes(origem)),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86_400,
  });
  await fastify.register(rateLimit, {
    max: config.LIMITE_GLOBAL_POR_MINUTO,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, contexto) =>
      erros.muitasRequisicoes(Math.max(1, Math.ceil(contexto.ttl / 1000))),
  });

  // Uma linha por requisição, sem IP, URL com parâmetros, corpo ou cabeçalhos.
  fastify.addHook('onResponse', async (req, reply) => {
    req.log.info(
      { metodo: req.method, rota: req.routeOptions.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'requisicao',
    );
  });

  fastify.setNotFoundHandler((_req, reply) => {
    const erro = erros.naoEncontrado();
    return reply.status(erro.status).send({ erro: { codigo: erro.codigo, mensagem: erro.message } });
  });

  fastify.setErrorHandler((erro: FastifyError | ErroApi, req, reply) => {
    if (erro instanceof ErroApi) {
      if (erro.retryAfter) reply.header('Retry-After', String(erro.retryAfter));
      return reply.status(erro.status).send({
        erro: {
          codigo: erro.codigo,
          mensagem: erro.message,
          ...(erro.campos ? { campos: erro.campos } : {}),
        },
      });
    }
    const codigo = (erro as FastifyError).code;
    if (codigo === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const e = erros.validacao('A requisição é grande demais.', { corpo: 'A requisição é grande demais.' });
      return reply.status(413).send({ erro: { codigo: e.codigo, mensagem: e.message, campos: e.campos } });
    }
    if (codigo?.startsWith('FST_ERR_CTP_')) {
      const e = erros.validacao('Corpo da requisição inválido.', { corpo: 'Corpo da requisição inválido.' });
      return reply.status(400).send({ erro: { codigo: e.codigo, mensagem: e.message, campos: e.campos } });
    }
    // Só o essencial vai para o log: nada do corpo, da URL ou de valores do banco.
    req.log.error({ codigo, nome: erro.name, mensagem: erro.message }, 'erro nao tratado');
    const interno = erros.interno();
    return reply.status(interno.status).send({ erro: { codigo: interno.codigo, mensagem: interno.message } });
  });

  const contexto = (req: FastifyRequest) => ({
    ip: req.ip || null,
    userAgent: req.headers['user-agent'] ?? null,
  });

  /** Exige `Authorization: Bearer` válido e deixa a sessão em `req.sessao`. */
  const exigirSessao = async (req: FastifyRequest) => {
    req.sessao = await auth.autenticar(tokenDoCabecalho(req));
  };

  fastify.get('/saude', async () => ({ ok: true }));

  await fastify.register(
    async (rotas) => {
      rotas.post('/cadastro', async (req, reply) => {
        const dados = validar(esquemaCadastro, req.body);
        const sessao = await auth.cadastrar(dados, contexto(req));
        return reply.status(201).send(sessao);
      });

      rotas.post('/login', async (req) => {
        const { email, senha } = validar(esquemaLogin, req.body);
        return auth.entrar(email, senha, contexto(req));
      });

      rotas.post('/logout', { preHandler: exigirSessao }, async (req, reply) => {
        await auth.sair(req.sessao!);
        return reply.status(204).send();
      });

      rotas.get('/eu', { preHandler: exigirSessao }, async (req) => ({
        usuario: await auth.perfilDaSessao(req.sessao!),
      }));

      rotas.post('/recuperacao/solicitar', async (req, reply) => {
        const { email } = validar(esquemaEmail, req.body);
        return reply.status(202).send(await auth.solicitarRecuperacao(email, contexto(req)));
      });

      rotas.post('/recuperacao/conferir', async (req, reply) => {
        const { email, codigo } = validar(esquemaCodigo, req.body);
        await auth.conferirCodigo(email, codigo, contexto(req));
        return reply.status(204).send();
      });

      rotas.post('/recuperacao/redefinir', async (req, reply) => {
        const corpo = (req.body ?? {}) as { codigo?: unknown };
        const { email, senha } = validar(esquemaRedefinicao, req.body);
        const codigo = typeof corpo.codigo === 'string' ? corpo.codigo : '';
        await auth.redefinirSenha(email, codigo, senha, contexto(req));
        return reply.status(204).send();
      });
    },
    { prefix: '/v1/auth' },
  );

  return { fastify, db, seg, auth };
}
