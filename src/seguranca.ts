import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Config } from './config.ts';

/** Tipos de token do banco usados aqui (`refined.token_verificacao.tipo`). */
export type TipoToken = 'recuperacao_senha';

export interface Seguranca {
  /** Hash argon2id da senha, no formato PHC (`$argon2id$...`). */
  hashSenha(senha: string): Promise<string>;
  /** Confere a senha. Hash inválido ou qualquer falha vira `false`, nunca exceção. */
  conferirSenha(hashGuardado: string, senha: string): Promise<boolean>;
  /**
   * Gasta o mesmo trabalho de uma conferência real. Serve para a conta inexistente demorar o mesmo
   * que a conta com senha errada, senão o tempo de resposta revela quais e-mails têm cadastro.
   */
  conferirSenhaFicticia(senha: string): Promise<void>;
  /** Token de sessão opaco (32 bytes aleatórios) e o SHA-256 que vai para o banco. */
  novoTokenSessao(): { token: string; hash: string };
  hashTokenSessao(token: string): string;
  /** Código de 6 dígitos, sorteado com `crypto.randomInt`. */
  novoCodigo(): string;
  /** HMAC do código, ligado ao usuário e ao tipo: o que fica no banco. Nunca o código. */
  hashCodigo(usuarioId: string, tipo: TipoToken, codigo: string): string;
  hashesIguais(a: string, b: string): boolean;
}

export function criarSeguranca(config: Pick<Config, 'ARGON2_MEMORIA_KIB' | 'SEGREDO_CODIGOS'>): Seguranca {
  // argon2id é o padrão do pacote; memória e tempo seguem a recomendação mínima da OWASP.
  const opcoes = { memoryCost: config.ARGON2_MEMORIA_KIB, timeCost: 2, parallelism: 1 };
  let hashFicticio: Promise<string> | undefined;

  const seguranca: Seguranca = {
    hashSenha: (senha) => hash(senha, opcoes),

    async conferirSenha(hashGuardado, senha) {
      try {
        return await verify(hashGuardado, senha);
      } catch {
        return false;
      }
    },

    async conferirSenhaFicticia(senha) {
      hashFicticio ??= hash(randomBytes(16).toString('hex'), opcoes);
      await verify(await hashFicticio, senha).catch(() => false);
    },

    novoTokenSessao() {
      const token = randomBytes(32).toString('base64url');
      return { token, hash: seguranca.hashTokenSessao(token) };
    },
    hashTokenSessao: (token) => createHash('sha256').update(token).digest('hex'),

    novoCodigo: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),

    hashCodigo: (usuarioId, tipo, codigo) =>
      createHmac('sha256', config.SEGREDO_CODIGOS).update(`${usuarioId}:${tipo}:${codigo}`).digest('hex'),

    hashesIguais(a, b) {
      const x = Buffer.from(a);
      const y = Buffer.from(b);
      return x.length === y.length && timingSafeEqual(x, y);
    },
  };
  return seguranca;
}
