import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { comTransacao, todas } from './_helpers.mjs';

const ESPERADAS = {
  raw: ['lote_ingestao', 'leitura_bruta'],
  trusted: ['dim_tempo', 'dim_local', 'dim_dispositivo', 'fato_leitura'],
  refined: [
    'usuario', 'colaborador', 'token_verificacao', 'login_provedor_externo', 'mfa_configuracao',
    'sessao_autenticacao', 'papel', 'permissao', 'papel_permissao', 'usuario_papel', 'colaborador_papel',
    'organizacao', 'usuario_organizacao', 'local', 'local_membro', 'lote_fabricacao', 'dispositivo',
    'dispositivo_estado', 'grupo_dispositivo', 'dispositivo_grupo', 'firmware_versao', 'feature_flag',
    'certificacao_dispositivo', 'garantia_dispositivo', 'modelo_ia_versao', 'leitura_sensor',
    'evento_sonoro_detectado', 'alerta', 'recomendacao', 'notificacao_enviada', 'preferencia_notificacao',
    'assinatura_plano', 'saude_conta', 'ticket_suporte', 'integracao_externa', 'log_auditoria',
    'solicitacao_titular_dados',
  ],
};
const SCHEMAS = Object.keys(ESPERADAS);

describe('estrutura do banco', () => {
  it('tem exatamente as tabelas do modelo, em cada camada', () =>
    comTransacao(async (c) => {
      for (const schema of SCHEMAS) {
        const linhas = await todas(
          c,
          `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
          [schema],
        );
        assert.deepEqual(linhas.map((l) => l.table_name).sort(), [...ESPERADAS[schema]].sort(), `schema ${schema}`);
      }
    }));

  it('toda tabela tem chave primaria', () =>
    comTransacao(async (c) => {
      const sem = await todas(
        c,
        `SELECT n.nspname || '.' || r.relname AS tabela FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
         WHERE r.relkind = 'r' AND n.nspname = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = r.oid AND k.contype = 'p')`,
        [SCHEMAS],
      );
      assert.deepEqual(sem, []);
    }));

  it('nomes seguem snake_case minusculo, sem prefixo is_/flag_ em booleanos', () =>
    comTransacao(async (c) => {
      const ruins = await todas(
        c,
        `SELECT table_schema || '.' || table_name || '.' || column_name AS col FROM information_schema.columns
         WHERE table_schema = ANY($1) AND (column_name !~ '^[a-z][a-z0-9_]*$'
            OR (data_type = 'boolean' AND column_name ~ '^(is_|flag_)'))`,
        [SCHEMAS],
      );
      assert.deepEqual(ruins, []);
    }));

  it('instantes usam TIMESTAMPTZ (ISO 8601 com fuso), nunca timestamp sem fuso', () =>
    comTransacao(async (c) => {
      const ruins = await todas(
        c,
        `SELECT table_schema || '.' || table_name || '.' || column_name AS col FROM information_schema.columns
         WHERE table_schema = ANY($1) AND data_type = 'timestamp without time zone'`,
        [SCHEMAS],
      );
      assert.deepEqual(ruins, []);
    }));

  it('toda tabela e todo schema tem comentario (banco autodocumentado)', () =>
    comTransacao(async (c) => {
      const sem = await todas(
        c,
        `SELECT n.nspname || '.' || r.relname AS tabela FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
         WHERE r.relkind = 'r' AND n.nspname = ANY($1) AND obj_description(r.oid, 'pg_class') IS NULL
         UNION ALL
         SELECT 'schema ' || nspname FROM pg_namespace WHERE nspname = ANY($1) AND obj_description(oid, 'pg_namespace') IS NULL`,
        [SCHEMAS],
      );
      assert.deepEqual(sem, []);
    }));

  it('toda chave estrangeira tem indice que a cobre (evita varredura em DELETE/JOIN)', () =>
    comTransacao(async (c) => {
      const sem = await todas(
        c,
        `SELECT c.conrelid::regclass::text AS tabela, c.conname AS fk
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE c.contype = 'f' AND n.nspname = ANY($1)
           AND NOT EXISTS (
             SELECT 1 FROM pg_index i
             WHERE i.indrelid = c.conrelid
               AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
               AND c.conkey @> (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)])`,
        [SCHEMAS],
      );
      assert.deepEqual(sem, []);
    }));

  it('a camada trusted nao contem coluna de dado pessoal', () =>
    comTransacao(async (c) => {
      const pessoais = await todas(
        c,
        `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
         WHERE table_schema = 'trusted'
           AND (column_name ~ '^(nome|nome_completo|email|telefone|latitude|longitude|cpf|ip_origem)$' OR column_name ~ '^senha')`,
      );
      assert.deepEqual(pessoais, []);
    }));

  it('dados de referencia do RBAC foram carregados', () =>
    comTransacao(async (c) => {
      const [{ n: papeis }] = await todas(c, 'SELECT count(*) AS n FROM refined.papel');
      assert.equal(Number(papeis), 5);
      const [{ faltam }] = await todas(
        c,
        `SELECT count(*) AS faltam FROM refined.permissao p
         WHERE NOT EXISTS (SELECT 1 FROM refined.papel_permissao pp JOIN refined.papel r ON r.id = pp.papel_id
                           WHERE pp.permissao_id = p.id AND r.nome = 'administrador')`,
      );
      assert.equal(Number(faltam), 0, 'administrador deve ter todas as permissoes');
    }));
});
