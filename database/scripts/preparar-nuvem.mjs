// Prepara um banco na nuvem (Supabase) para a API: migrations, papel de login da API e conferência.
//
//   ADMIN_DATABASE_URL=postgres://postgres...  API_DB_SENHA=...  API_DATABASE_URL=postgres://clean_air_api...  \
//     npm run db:nuvem
//
// As três variáveis vêm do ambiente, nunca de argumento nem de arquivo do repositório, e o script
// não imprime nenhuma delas. Pode ser rodado de novo: migrations já aplicadas são puladas e o papel
// só tem a senha atualizada.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrar } from './ambiente.mjs';

const PAPEL_API = 'clean_air_api';

async function conectar(url, rotulo) {
  const cliente = new pg.Client({ connectionString: url, ssl: usaTls(url) ? { rejectUnauthorized: false } : undefined });
  try {
    await cliente.connect();
  } catch (erro) {
    // A mensagem do pg pode conter o host; mostra só o motivo, nunca a URL.
    throw new Error(`não consegui conectar (${rotulo}): ${erro.code ?? erro.message.split('\n')[0]}`);
  }
  return cliente;
}

function usaTls(url) {
  const host = new URL(url).hostname;
  return host !== 'localhost' && host !== '127.0.0.1';
}

export async function prepararNuvem({ adminUrl, apiUrl, senhaApi, log = console.log }) {
  if (!adminUrl || !apiUrl || !senhaApi) {
    throw new Error('Defina ADMIN_DATABASE_URL, API_DATABASE_URL e API_DB_SENHA no ambiente.');
  }
  if (senhaApi.length < 16) throw new Error('API_DB_SENHA precisa ter ao menos 16 caracteres.');

  // 1. Migrations. Só o usuário administrativo cria papéis e tabelas.
  const separador = adminUrl.includes('?') ? '&' : '?';
  const urlAdmin = usaTls(adminUrl) && !/sslmode=/.test(adminUrl) ? `${adminUrl}${separador}sslmode=no-verify` : adminUrl;
  const aplicadas = await migrar(urlAdmin, 'up');
  log(`1/4 migrations: ${aplicadas.length === 0 ? 'já estavam em dia' : `${aplicadas.length} aplicada(s)`}`);

  // 2. Papel de login da API: sem privilégio próprio (NOINHERIT), só pode virar auth ou app.
  const admin = await conectar(adminUrl, 'usuário administrativo');
  try {
    const senha = admin.escapeLiteral(senhaApi);
    const { rowCount } = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [PAPEL_API]);
    if (rowCount === 0) {
      await admin.query(
        `CREATE ROLE ${PAPEL_API} LOGIN PASSWORD ${senha} NOINHERIT IN ROLE clean_air_auth, clean_air_app`,
      );
      log(`2/4 papel ${PAPEL_API}: criado`);
    } else {
      await admin.query(`ALTER ROLE ${PAPEL_API} LOGIN PASSWORD ${senha} NOINHERIT`);
      await admin.query(`GRANT clean_air_auth, clean_air_app TO ${PAPEL_API}`);
      log(`2/4 papel ${PAPEL_API}: já existia, senha atualizada`);
    }
  } finally {
    await admin.end();
  }

  // 3 e 4. Conferência com a conexão que a API vai usar.
  const api = await conectar(apiUrl, PAPEL_API);
  try {
    const { rows } = await api.query(
      `SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const r = rows[0];
    if (!r || r.rolsuper || r.rolcreaterole || r.rolcreatedb || r.rolbypassrls) {
      throw new Error('o papel de login da API tem poder demais (superusuário, CREATEROLE, CREATEDB ou BYPASSRLS)');
    }

    let negado = false;
    try {
      await api.query(`SELECT count(*) FROM refined.usuario`);
    } catch (erro) {
      negado = erro.code === '42501';
    }
    if (!negado) throw new Error('o papel de login consegue ler refined.usuario sem SET ROLE; era para falhar fechado');
    log('3/4 sem SET ROLE o papel de login não lê nada: OK');

    for (const papel of ['clean_air_auth', 'clean_air_app']) {
      await api.query('BEGIN');
      try {
        await api.query(`SET LOCAL ROLE ${papel}`);
        await api.query(`SELECT count(*) FROM refined.papel`);
      } catch (erro) {
        throw new Error(`SET LOCAL ROLE ${papel} falhou (${erro.code ?? 'sem código'}): a troca de papel não está valendo aqui`);
      } finally {
        await api.query('ROLLBACK');
      }
    }
    log('4/4 SET LOCAL ROLE clean_air_auth e clean_air_app: OK');
  } finally {
    await api.end();
  }
  log('Banco pronto para a API.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await prepararNuvem({
      adminUrl: process.env.ADMIN_DATABASE_URL,
      apiUrl: process.env.API_DATABASE_URL,
      senhaApi: process.env.API_DB_SENHA,
    });
  } catch (erro) {
    console.error(`Falhou: ${erro.message}`);
    process.exit(1);
  }
}
