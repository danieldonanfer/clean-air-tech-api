import { z } from 'zod';

/** Origens do front aceitas por padrão (CORS). `CORS_ORIGINS` acrescenta outras. */
export const ORIGENS_PADRAO = [
  'https://danieldonanfer.github.io',
  'http://localhost:8081',
  'http://localhost:19006',
];

const booleano = z
  .enum(['true', 'false'])
  .default('false')
  .transform((valor) => valor === 'true');

const esquema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    // Banco: conecta com um papel de login que só vira clean_air_auth / clean_air_app por transação.
    DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
    DATABASE_SSL: booleano,

    CORS_ORIGINS: z.string().default(''),
    // Atrás de proxy (Render) o IP real vem em X-Forwarded-For.
    TRUST_PROXY: booleano,

    EMAIL_MODE: z.enum(['smtp', 'console']).default('console'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: booleano,
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    EMAIL_FROM: z.string().default('Clean Air Tech <nao-responder@cleanairtech.local>'),

    // Chave do HMAC que protege os códigos de recuperação guardados no banco.
    SEGREDO_CODIGOS: z.string().min(32, 'SEGREDO_CODIGOS precisa ter ao menos 32 caracteres'),

    SESSAO_DIAS: z.coerce.number().int().positive().default(7),
    ARGON2_MEMORIA_KIB: z.coerce.number().int().min(8).default(19456),
    LIMITE_GLOBAL_POR_MINUTO: z.coerce.number().int().positive().default(120),
    RECUPERACAO_PEDIDOS_POR_HORA: z.coerce.number().int().positive().default(3),
    // Tempo mínimo das respostas que não podem denunciar se a conta existe (login que falha e pedido
    // de recuperação). Cobre a diferença entre o caminho que escreve no banco e o que só lê.
    ATRASO_MINIMO_MS: z.coerce.number().int().min(0).default(250),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.EMAIL_MODE === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_MODE'],
        message: 'EMAIL_MODE=console é só para desenvolvimento; em produção use smtp',
      });
    }
    if (env.EMAIL_MODE === 'smtp' && !env.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP_HOST é obrigatória com EMAIL_MODE=smtp' });
    }
  });

export type Config = z.infer<typeof esquema> & { origensPermitidas: string[] };

/** Lê e valida o ambiente. A mensagem de erro lista só os nomes das variáveis, nunca os valores. */
export function carregarConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const resultado = esquema.safeParse(env);
  if (!resultado.success) {
    const problemas = resultado.error.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${problemas}`);
  }
  const extras = resultado.data.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return { ...resultado.data, origensPermitidas: [...new Set([...ORIGENS_PADRAO, ...extras])] };
}
