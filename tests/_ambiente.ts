import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import assert from 'node:assert/strict';
import pg from 'pg';
import { criarApp, type App } from '../src/app.ts';
import { carregarConfig } from '../src/config.ts';
import type { Destinatario, Mailer } from '../src/email.ts';

export const SENHA_BOA = 'Purifica@2025';

/** Captura os e-mails em vez de enviá-los. */
export class MailerFalso implements Mailer {
  enviados: { para: Destinatario; codigo: string }[] = [];
  async enviarCodigoRecuperacao(para: Destinatario, codigo: string): Promise<void> {
    this.enviados.push({ para, codigo });
  }
  ultimoCodigo(email: string): string {
    const envio = [...this.enviados].reverse().find((e) => e.para.email === email);
    assert.ok(envio, `nenhum e-mail enviado para ${email}`);
    return envio.codigo;
  }
}

export interface Ambiente {
  app: App;
  mailer: MailerFalso;
  /** Linhas de log emitidas pela API. */
  logs: string[];
  /** Conexão de superusuário só para conferir e preparar dados nos testes. */
  admin: pg.Client;
  fechar(): Promise<void>;
}

export async function iniciar(extras: Record<string, string> = {}): Promise<Ambiente> {
  const logs: string[] = [];
  const logStream = new Writable({
    write(pedaco, _codificacao, pronto) {
      logs.push(String(pedaco));
      pronto();
    },
  });
  const mailer = new MailerFalso();
  const config = carregarConfig({
    NODE_ENV: 'test',
    DATABASE_URL: process.env.API_DATABASE_URL ?? '',
    SEGREDO_CODIGOS: 'segredo-de-teste-com-mais-de-32-caracteres',
    ARGON2_MEMORIA_KIB: '1024',
    LIMITE_GLOBAL_POR_MINUTO: '100000',
    RECUPERACAO_PEDIDOS_POR_HORA: '1000',
    ATRASO_MINIMO_MS: '150',
    LOG_LEVEL: 'info',
    ...extras,
  });
  const app = await criarApp({ config, mailer, logStream });
  const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin.connect();
  return {
    app,
    mailer,
    logs,
    admin,
    async fechar() {
      await app.fastify.close();
      await app.db.encerrar();
      await admin.end();
    },
  };
}

let contador = 0;
export const emailUnico = (prefixo = 'u') => `${prefixo}${++contador}.${randomBytes(3).toString('hex')}@teste.com`;
/** Celular brasileiro válido e único: 11 9 + 8 dígitos aleatórios. */
export const telefoneUnico = () => `119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;

export interface Resposta<T = any> {
  status: number;
  corpo: T;
  headers: Record<string, string | string[] | number | undefined>;
}

export function api(ambiente: Ambiente) {
  async function chamar(
    metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'OPTIONS',
    url: string,
    opcoes: { corpo?: unknown; token?: string; headers?: Record<string, string> } = {},
  ): Promise<Resposta> {
    const r = await ambiente.app.fastify.inject({
      method: metodo,
      url,
      ...(opcoes.corpo !== undefined ? { payload: opcoes.corpo as object } : {}),
      headers: {
        ...(opcoes.token ? { authorization: `Bearer ${opcoes.token}` } : {}),
        ...opcoes.headers,
      },
    });
    let corpo: unknown = null;
    try {
      corpo = r.body ? JSON.parse(r.body) : null;
    } catch {
      corpo = r.body;
    }
    return { status: r.statusCode, corpo, headers: r.headers };
  }

  return {
    chamar,
    post: (url: string, corpo?: unknown, token?: string) =>
      chamar('POST', url, { ...(corpo !== undefined ? { corpo } : {}), ...(token ? { token } : {}) }),
    get: (url: string, token?: string) => chamar('GET', url, token ? { token } : {}),

    async cadastrar(extra: Record<string, unknown> = {}) {
      const dados = {
        nome: 'Ana Silva',
        email: emailUnico(),
        telefone: telefoneUnico(),
        senha: SENHA_BOA,
        objetivo: 'ar',
        aceitouTermos: true,
        ...extra,
      };
      const r = await chamar('POST', '/v1/auth/cadastro', { corpo: dados });
      assert.equal(r.status, 201, JSON.stringify(r.corpo));
      return { ...r.corpo, email: String(dados.email).toLowerCase(), senha: String(dados.senha) } as {
        token: string;
        usuario: Record<string, string>;
        email: string;
        senha: string;
      };
    },
  };
}

export async function um<T = any>(admin: pg.Client, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await admin.query(sql, params);
  return rows[0] as T;
}
