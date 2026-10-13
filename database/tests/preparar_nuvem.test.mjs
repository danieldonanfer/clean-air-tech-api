import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import pg from 'pg';
import { prepararNuvem } from '../scripts/preparar-nuvem.mjs';

const SENHA = 'senha-de-teste-bem-longa-9X';

describe('preparar-nuvem (papel de login da API)', () => {
  const admin = process.env.DATABASE_URL;
  const api = admin.replace(/\/\/[^@]+@/, `//clean_air_api:${SENHA}@`);

  after(async () => {
    const c = new pg.Client({ connectionString: admin });
    await c.connect();
    await c.query('DROP OWNED BY clean_air_api').catch(() => {});
    await c.query('DROP ROLE IF EXISTS clean_air_api');
    await c.end();
  });

  it('cria o papel, confere a troca de papel e pode ser repetido (só atualiza a senha)', async () => {
    const saida = [];
    const log = (linha) => saida.push(linha);
    await prepararNuvem({ adminUrl: admin, apiUrl: api, senhaApi: SENHA, log });
    assert.match(saida.join('\n'), /papel clean_air_api: criado/);
    assert.match(saida.join('\n'), /Banco pronto para a API/);

    const de_novo = [];
    await prepararNuvem({ adminUrl: admin, apiUrl: api, senhaApi: SENHA, log: (l) => de_novo.push(l) });
    assert.match(de_novo.join('\n'), /já existia, senha atualizada/);
  });

  it('nunca imprime a senha nem as URLs', async () => {
    const saida = [];
    await prepararNuvem({ adminUrl: admin, apiUrl: api, senhaApi: SENHA, log: (l) => saida.push(l) });
    const texto = saida.join('\n');
    assert.ok(!texto.includes(SENHA));
    assert.ok(!texto.includes(admin));
  });

  it('recusa senha curta e variáveis faltando antes de tocar no banco', async () => {
    await assert.rejects(prepararNuvem({ adminUrl: admin, apiUrl: api, senhaApi: 'curta' }), /16 caracteres/);
    await assert.rejects(prepararNuvem({ adminUrl: admin, apiUrl: '', senhaApi: SENHA }), /Defina ADMIN_DATABASE_URL/);
  });

  it('o erro de conexão não vaza a URL nem a senha', async () => {
    const ruim = api.replace(/\/\/[^@]+@/, '//clean_air_api:errada-errada-errada@');
    await assert.rejects(
      prepararNuvem({ adminUrl: admin, apiUrl: ruim, senhaApi: SENHA, log: () => {} }),
      (erro) => !erro.message.includes('errada-errada') && !erro.message.includes(SENHA) && /clean_air_api/.test(erro.message),
    );
  });
});
