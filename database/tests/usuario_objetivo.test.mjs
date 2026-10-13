import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comoApp, comoPapel, comTransacao, criarUsuario, rejeita, um } from './_helpers.mjs';

const VIOLA_CHECK = '23514';
const SEM_PRIVILEGIO = '42501';

describe('objetivo de uso do usuario (migration 0010)', () => {
  it('o padrao e "outro" e so aceita as quatro chaves do aplicativo', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c, 'obj1');
      assert.equal(u.objetivo_uso, 'outro');
      for (const chave of ['ar', 'alergia', 'conforto', 'outro']) {
        await c.query(`UPDATE refined.usuario SET objetivo_uso = $1 WHERE id = $2`, [chave, u.id]);
      }
      await rejeita(c, `UPDATE refined.usuario SET objetivo_uso = 'monitoramento' WHERE id = $1`, [u.id], { codigo: VIOLA_CHECK });
    }));

  it('o papel de cadastro grava o objetivo no INSERT', () =>
    comTransacao(async (c) => {
      const criado = await comoPapel(c, 'clean_air_auth', null, () =>
        um(
          c,
          `INSERT INTO refined.usuario (nome_completo, email, senha_hash, objetivo_uso) VALUES ('Ana', 'ana.obj@x.com', 'h', 'alergia') RETURNING objetivo_uso`,
        ),
      );
      assert.equal(criado.objetivo_uso, 'alergia');
    }));

  it('o usuario final le o proprio objetivo, mas nao o altera', () =>
    comTransacao(async (c) => {
      const u = await criarUsuario(c, 'obj2');
      await c.query(`UPDATE refined.usuario SET objetivo_uso = 'conforto' WHERE id = $1`, [u.id]);
      await comoApp(c, u.id, async () => {
        const lido = await um(c, `SELECT objetivo_uso FROM refined.usuario WHERE id = $1`, [u.id]);
        assert.equal(lido.objetivo_uso, 'conforto');
        await rejeita(c, `UPDATE refined.usuario SET objetivo_uso = 'ar' WHERE id = $1`, [u.id], { codigo: SEM_PRIVILEGIO });
      });
    }));
});
