import pg from 'pg';
import type { Config } from './config.ts';

/** Papéis de banco que a API pode assumir. Lista fechada: o nome vai direto no SQL. */
export type Papel = 'clean_air_auth' | 'clean_air_app';
const PAPEIS: readonly Papel[] = ['clean_air_auth', 'clean_air_app'];

export type Cliente = pg.PoolClient;

export interface Banco {
  /**
   * Executa `fn` numa transação sob um papel de banco. O papel de login da API não tem privilégio
   * nenhum por conta própria (NOINHERIT), então esquecer o `SET LOCAL ROLE` falha fechado.
   * `usuarioId` informa o usuário da sessão para a RLS (`app.usuario_id`).
   */
  transacao<T>(papel: Papel, usuarioId: string | null, fn: (c: Cliente) => Promise<T>): Promise<T>;
  encerrar(): Promise<void>;
}

export function criarBanco(config: Pick<Config, 'DATABASE_URL' | 'DATABASE_SSL'>): Banco {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  });
  // Erro numa conexão ociosa não pode derrubar o processo.
  pool.on('error', () => {});

  return {
    async transacao(papel, usuarioId, fn) {
      if (!PAPEIS.includes(papel)) throw new Error('Papel de banco desconhecido.');
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        await cliente.query(`SET LOCAL ROLE ${papel}`);
        if (usuarioId) await cliente.query(`SELECT set_config('app.usuario_id', $1, true)`, [usuarioId]);
        const resultado = await fn(cliente);
        await cliente.query('COMMIT');
        return resultado;
      } catch (erro) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw erro;
      } finally {
        cliente.release();
      }
    },
    async encerrar() {
      await pool.end();
    },
  };
}
