import assert from 'node:assert/strict';
import pg from 'pg';

// Cada teste roda dentro de uma transacao que sofre ROLLBACK: nenhum dado vaza entre testes.
export async function comTransacao(fn) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query('BEGIN');
    await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

// Executa e exige que o banco REJEITE; o SAVEPOINT mantem a transacao do teste utilizavel.
export async function rejeita(c, sql, params = [], { codigo, trecho } = {}) {
  await c.query('SAVEPOINT tentativa');
  let erro = null;
  try {
    await c.query(sql, params);
  } catch (e) {
    erro = e;
  }
  await c.query('ROLLBACK TO SAVEPOINT tentativa');
  assert.ok(erro, `esperava erro, mas passou: ${sql.slice(0, 90)}`);
  if (codigo) assert.equal(erro.code, codigo, `codigo ${erro.code} (${erro.message})`);
  if (trecho) assert.match(erro.message, trecho);
  return erro;
}

export const um = async (c, sql, params = []) => (await c.query(sql, params)).rows[0];
export const todas = async (c, sql, params = []) => (await c.query(sql, params)).rows;
export const contar = async (c, sql, params = []) => Number((await c.query(sql, params)).rows[0].n);

// Fabricas de dados minimos validos.
export async function criarUsuario(c, sufixo = Math.random().toString(36).slice(2, 8), extra = {}) {
  return um(
    c,
    `INSERT INTO refined.usuario (nome_completo, email, senha_hash)
     VALUES ($1, $2, 'argon2-hash') RETURNING *`,
    [extra.nome ?? `Usuario ${sufixo}`, extra.email ?? `u_${sufixo}@teste.com`],
  );
}
export async function criarLocal(c, usuarioId, extra = {}) {
  return um(
    c,
    `INSERT INTO refined.local (usuario_id, nome, tipo_local, organizacao_id, local_pai_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [usuarioId, extra.nome ?? 'Sala', extra.tipo ?? 'comodo', extra.organizacaoId ?? null, extra.paiId ?? null],
  );
}
export async function criarDispositivo(c, localId, usuarioId, extra = {}) {
  return um(
    c,
    `INSERT INTO refined.dispositivo (local_id, usuario_proprietario_id, numero_serie, modelo)
     VALUES ($1, $2, $3, 'CAT-1') RETURNING *`,
    [localId, usuarioId, extra.serie ?? `SN-${Math.random().toString(36).slice(2, 10)}`],
  );
}

// Executa como um papel de banco (padrao: o da API), identificando o usuario da sessao.
// O ROLLBACK ao savepoint desfaz papel, variavel de sessao e qualquer escrita feita no bloco.
export async function comoPapel(c, papel, usuarioId, fn) {
  await c.query('SAVEPOINT como_papel');
  try {
    await c.query(`SET LOCAL ROLE ${papel}`);
    if (usuarioId) await c.query(`SELECT set_config('app.usuario_id', $1, true)`, [usuarioId]);
    return await fn();
  } finally {
    await c.query('ROLLBACK TO SAVEPOINT como_papel');
    await c.query('RELEASE SAVEPOINT como_papel');
  }
}
export const comoApp = (c, usuarioId, fn) => comoPapel(c, 'clean_air_app', usuarioId, fn);
