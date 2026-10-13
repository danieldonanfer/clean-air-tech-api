import type { Config } from './config.ts';
import type { Banco, Cliente } from './db.ts';
import type { Mailer, Registro } from './email.ts';
import { erros } from './erros.ts';
import { Limitador } from './limitador.ts';
import type { Seguranca } from './seguranca.ts';
import { lerUsuario, type UsuarioDto } from './usuario.ts';
import { codigoComFormatoValido, type Objetivo } from './validacao.ts';

/** Versão dos Termos de Uso gravada no aceite (`usuario.termos_uso_versao_aceita`). */
export const TERMOS_VERSAO = '2026-10';

export const VALIDADE_CODIGO_SEGUNDOS = 300;
const MAX_TENTATIVAS_CODIGO = 5;
const MAX_FALHAS_LOGIN = 5;
const BLOQUEIO_LOGIN_MINUTOS = 15;

/** Alertas ligados por padrão no cadastro (canal push). */
const ALERTAS_PADRAO = ['pm25_alto', 'pm10_alto', 'co2_alto', 'tvoc_alto'];

export interface Contexto {
  ip: string | null;
  userAgent: string | null;
}

export interface Sessao {
  token: string;
  usuario: UsuarioDto;
}

export interface SessaoAutenticada {
  sessaoId: string;
  usuarioId: string;
}

export interface DadosCadastro {
  nome: string;
  email: string;
  telefone?: string | null | undefined;
  senha: string;
  objetivo: Objetivo;
}

export interface ServicoAuth {
  cadastrar(dados: DadosCadastro, ctx: Contexto): Promise<Sessao>;
  entrar(email: string, senha: string, ctx: Contexto): Promise<Sessao>;
  autenticar(token: string | null): Promise<SessaoAutenticada>;
  perfilDaSessao(sessao: SessaoAutenticada): Promise<UsuarioDto>;
  sair(sessao: SessaoAutenticada): Promise<void>;
  solicitarRecuperacao(email: string, ctx: Contexto): Promise<{ expiraEmSegundos: number }>;
  conferirCodigo(email: string, codigo: string, ctx: Contexto): Promise<void>;
  redefinirSenha(email: string, codigo: string, senha: string, ctx: Contexto): Promise<void>;
}

export interface DependenciasAuth {
  db: Banco;
  seg: Seguranca;
  mailer: Mailer;
  config: Config;
  log: Registro;
}

interface ErroPg {
  code?: string;
  constraint?: string;
}

async function criarSessao(
  c: Cliente,
  seg: Seguranca,
  config: Config,
  usuarioId: string,
  ctx: Contexto,
): Promise<string> {
  const { token, hash } = seg.novoTokenSessao();
  await c.query(
    `INSERT INTO refined.sessao_autenticacao (usuario_id, token_hash, ip_origem, user_agent, expira_em)
     VALUES ($1, $2, $3::inet, $4, now() + make_interval(days => $5))`,
    [usuarioId, hash, ctx.ip, ctx.userAgent?.slice(0, 300) ?? null, config.SESSAO_DIAS],
  );
  return token;
}

/** Espera o que falta para a resposta completar `minimoMs` desde `inicio`. */
async function completarAte(inicio: number, minimoMs: number): Promise<void> {
  const falta = minimoMs - (performance.now() - inicio);
  if (falta > 0) await new Promise((resolver) => setTimeout(resolver, falta));
}

export function criarServicoAuth({ db, seg, mailer, config, log }: DependenciasAuth): ServicoAuth {
  const pedidosPorEmail = new Limitador(config.RECUPERACAO_PEDIDOS_POR_HORA, 60 * 60_000);
  const pedidosPorIp = new Limitador(config.RECUPERACAO_PEDIDOS_POR_HORA, 60 * 60_000);
  const tentativasDeCodigo = new Limitador(10, 10 * 60_000);

  /**
   * Confere o código dentro da transação. Errar conta como tentativa e, na quinta, o código morre.
   * Devolve `null` se o código não vale (ou não existe) — sem dizer qual dos dois.
   */
  async function verificarCodigo(
    c: Cliente,
    email: string,
    codigo: string,
  ): Promise<{ usuarioId: string; tokenId: string } | null> {
    const { rows } = await c.query<{ usuario_id: string; token_id: string; token_hash: string }>(
      `SELECT u.id AS usuario_id, t.id AS token_id, t.token_hash
         FROM refined.usuario u
         JOIN refined.token_verificacao t
           ON t.usuario_id = u.id AND t.tipo = 'recuperacao_senha'
          AND t.usado_em IS NULL AND t.expira_em > now() AND t.tentativas_uso < $2
        WHERE lower(u.email) = $1 AND u.removido_em IS NULL AND u.status_conta = 'ativo'
        ORDER BY t.criado_em DESC
        LIMIT 1
        FOR UPDATE OF t`,
      [email, MAX_TENTATIVAS_CODIGO],
    );
    const linha = rows[0];
    if (!linha) {
      // Gasta o mesmo cálculo para a resposta não variar com a existência da conta.
      seg.hashCodigo('00000000-0000-0000-0000-000000000000', 'recuperacao_senha', codigo);
      return null;
    }
    const esperado = seg.hashCodigo(linha.usuario_id, 'recuperacao_senha', codigo);
    if (!seg.hashesIguais(linha.token_hash, esperado)) {
      await c.query(
        `UPDATE refined.token_verificacao
            SET tentativas_uso = tentativas_uso + 1,
                usado_em = CASE WHEN tentativas_uso + 1 >= $2 THEN now() END
          WHERE id = $1`,
        [linha.token_id, MAX_TENTATIVAS_CODIGO],
      );
      return null;
    }
    return { usuarioId: linha.usuario_id, tokenId: linha.token_id };
  }

  function limitarCodigo(email: string, ctx: Contexto): void {
    const espera = tentativasDeCodigo.tentar(`${ctx.ip ?? 'ip?'}|${email}`);
    if (espera !== null) throw erros.muitasRequisicoes(espera);
  }

  return {
    async cadastrar(dados, ctx) {
      const senhaHash = await seg.hashSenha(dados.senha);
      try {
        return await db.transacao('clean_air_auth', null, async (c) => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO refined.usuario
               (nome_completo, email, senha_hash, telefone, objetivo_uso,
                consentimento_lgpd_aceito, consentimento_lgpd_data,
                termos_uso_versao_aceita, termos_uso_aceito_em, senha_alterada_em)
             VALUES ($1, $2, $3, $4, $5, true, now(), $6, now(), now())
             RETURNING id`,
            [dados.nome, dados.email, senhaHash, dados.telefone ?? null, dados.objetivo, TERMOS_VERSAO],
          );
          const id = rows[0]!.id;
          await c.query(`INSERT INTO refined.assinatura_plano (usuario_id) VALUES ($1)`, [id]);
          await c.query(
            `INSERT INTO refined.usuario_papel (usuario_id, papel_id)
             SELECT $1, id FROM refined.papel WHERE nome = 'cliente_basico'`,
            [id],
          );
          await c.query(
            `INSERT INTO refined.preferencia_notificacao (usuario_id, tipo_alerta, canal)
             SELECT $1, tipo, 'push' FROM unnest($2::text[]) AS tipo`,
            [id, ALERTAS_PADRAO],
          );
          const token = await criarSessao(c, seg, config, id, ctx);
          const usuario = await lerUsuario(c, id);
          return { token, usuario: usuario! };
        });
      } catch (erro) {
        const pg = erro as ErroPg;
        if (pg.code === '23505') {
          if (pg.constraint === 'ux_usuario_telefone') throw erros.telefoneJaCadastrado();
          throw erros.emailJaCadastrado();
        }
        throw erro;
      }
    },

    async entrar(email, senha, ctx) {
      const inicio = performance.now();
      const resultado = await db.transacao('clean_air_auth', null, async (c) => {
        const { rows } = await c.query<{
          id: string;
          senha_hash: string;
          status_conta: string;
          tentativas_login_falhas: number;
          restante_segundos: number | null;
        }>(
          `SELECT id, senha_hash, status_conta, tentativas_login_falhas,
                  CASE WHEN bloqueado_ate > now()
                       THEN extract(epoch FROM bloqueado_ate - now())::float8 END AS restante_segundos
             FROM refined.usuario
            WHERE lower(email) = $1 AND removido_em IS NULL
              FOR UPDATE`,
          [email],
        );
        const u = rows[0];
        if (!u || u.status_conta === 'encerrado') return { tipo: 'inexistente' as const };
        if (u.restante_segundos !== null) {
          return { tipo: 'bloqueada' as const, minutos: Math.ceil(u.restante_segundos / 60) };
        }

        if (!(await seg.conferirSenha(u.senha_hash, senha))) {
          const falhas = u.tentativas_login_falhas + 1;
          if (falhas >= MAX_FALHAS_LOGIN) {
            await c.query(
              `UPDATE refined.usuario
                  SET tentativas_login_falhas = 0, bloqueado_ate = now() + make_interval(mins => $2)
                WHERE id = $1`,
              [u.id, BLOQUEIO_LOGIN_MINUTOS],
            );
          } else {
            await c.query(`UPDATE refined.usuario SET tentativas_login_falhas = $2 WHERE id = $1`, [u.id, falhas]);
          }
          return { tipo: 'falha' as const };
        }
        // Só depois de acertar a senha dizemos que a conta está suspensa.
        if (u.status_conta !== 'ativo') return { tipo: 'suspensa' as const };

        await c.query(
          `UPDATE refined.usuario
              SET tentativas_login_falhas = 0, bloqueado_ate = NULL, ultimo_login_em = now()
            WHERE id = $1`,
          [u.id],
        );
        const token = await criarSessao(c, seg, config, u.id, ctx);
        return { tipo: 'ok' as const, token, usuario: (await lerUsuario(c, u.id))! };
      });

      if (resultado.tipo === 'ok') return { token: resultado.token, usuario: resultado.usuario };

      // Mesmo custo da conta com senha errada, e um piso de tempo que cobre a escrita do contador
      // de falhas: o tempo da resposta não pode denunciar quais e-mails têm cadastro.
      if (resultado.tipo === 'inexistente') await seg.conferirSenhaFicticia(senha);
      await completarAte(inicio, config.ATRASO_MINIMO_MS);
      switch (resultado.tipo) {
        case 'bloqueada':
          throw erros.contaBloqueada(resultado.minutos);
        case 'suspensa':
          throw erros.contaSuspensa();
        default:
          throw erros.credenciaisInvalidas();
      }
    },

    async autenticar(token) {
      if (!token || token.length > 200) throw erros.sessaoInvalida();
      const sessao = await db.transacao('clean_air_auth', null, async (c) => {
        const { rows } = await c.query<{ sessao_id: string; usuario_id: string }>(
          `SELECT s.id AS sessao_id, s.usuario_id
             FROM refined.sessao_autenticacao s
             JOIN refined.usuario u ON u.id = s.usuario_id
            WHERE s.token_hash = $1 AND s.revogado_em IS NULL AND s.expira_em > now()
              AND u.removido_em IS NULL AND u.status_conta = 'ativo'`,
          [seg.hashTokenSessao(token)],
        );
        return rows[0];
      });
      if (!sessao) throw erros.sessaoInvalida();
      return { sessaoId: sessao.sessao_id, usuarioId: sessao.usuario_id };
    },

    async perfilDaSessao(sessao) {
      const usuario = await db.transacao('clean_air_app', sessao.usuarioId, (c) =>
        lerUsuario(c, sessao.usuarioId),
      );
      if (!usuario) throw erros.sessaoInvalida();
      return usuario;
    },

    async sair(sessao) {
      await db.transacao('clean_air_app', sessao.usuarioId, (c) =>
        c.query(
          `UPDATE refined.sessao_autenticacao SET revogado_em = now() WHERE id = $1 AND revogado_em IS NULL`,
          [sessao.sessaoId],
        ),
      );
    },

    async solicitarRecuperacao(email, ctx) {
      const inicio = performance.now();
      // Conta toda tentativa, exista a conta ou não: o limite não pode revelar quem tem cadastro.
      const espera =
        pedidosPorEmail.tentar(email) ?? pedidosPorIp.tentar(ctx.ip ?? 'ip?');
      if (espera !== null) throw erros.muitasRequisicoes(espera);

      const envio = await db.transacao('clean_air_auth', null, async (c) => {
        const { rows } = await c.query<{ id: string; nome_completo: string; email: string }>(
          `SELECT id, nome_completo, email
             FROM refined.usuario
            WHERE lower(email) = $1 AND removido_em IS NULL AND status_conta = 'ativo'
              FOR UPDATE`,
          [email],
        );
        const u = rows[0];
        if (!u) return null;
        // Um pedido novo invalida os anteriores.
        await c.query(
          `UPDATE refined.token_verificacao SET usado_em = now()
            WHERE usuario_id = $1 AND tipo = 'recuperacao_senha' AND usado_em IS NULL`,
          [u.id],
        );
        const codigo = seg.novoCodigo();
        await c.query(
          `INSERT INTO refined.token_verificacao (usuario_id, tipo, token_hash, expira_em)
           VALUES ($1, 'recuperacao_senha', $2, now() + make_interval(secs => $3))`,
          [u.id, seg.hashCodigo(u.id, 'recuperacao_senha', codigo), VALIDADE_CODIGO_SEGUNDOS],
        );
        return { para: { email: u.email, nome: u.nome_completo }, codigo };
      });

      if (envio) {
        // Sem esperar: o tempo da resposta é o mesmo exista a conta ou não. A falha vai para o log.
        void mailer.enviarCodigoRecuperacao(envio.para, envio.codigo).catch((erro: unknown) => {
          log.error(
            { erro: erro instanceof Error ? erro.message : 'desconhecido' },
            'Falha ao enviar o e-mail de recuperação',
          );
        });
      }
      // O caminho da conta existente escreve no banco e o da inexistente não: o piso iguala o tempo.
      await completarAte(inicio, config.ATRASO_MINIMO_MS);
      return { expiraEmSegundos: VALIDADE_CODIGO_SEGUNDOS };
    },

    async conferirCodigo(email, codigo, ctx) {
      limitarCodigo(email, ctx);
      if (!codigoComFormatoValido(codigo)) throw erros.codigoInvalido();
      const valido = await db.transacao('clean_air_auth', null, (c) => verificarCodigo(c, email, codigo));
      if (!valido) throw erros.codigoInvalido();
    },

    async redefinirSenha(email, codigo, senha, ctx) {
      limitarCodigo(email, ctx);
      if (!codigoComFormatoValido(codigo)) throw erros.codigoInvalido();
      const redefinida = await db.transacao('clean_air_auth', null, async (c) => {
        const valido = await verificarCodigo(c, email, codigo);
        if (!valido) return false;
        const novoHash = await seg.hashSenha(senha);
        await c.query(
          `UPDATE refined.usuario
              SET senha_hash = $2, senha_alterada_em = now(),
                  tentativas_login_falhas = 0, bloqueado_ate = NULL
            WHERE id = $1`,
          [valido.usuarioId, novoHash],
        );
        // Consome o código e qualquer outro pendente; derruba todas as sessões da conta.
        await c.query(
          `UPDATE refined.token_verificacao SET usado_em = now()
            WHERE usuario_id = $1 AND tipo = 'recuperacao_senha' AND usado_em IS NULL`,
          [valido.usuarioId],
        );
        await c.query(
          `UPDATE refined.sessao_autenticacao SET revogado_em = now()
            WHERE usuario_id = $1 AND revogado_em IS NULL`,
          [valido.usuarioId],
        );
        return true;
      });
      if (!redefinida) throw erros.codigoInvalido();
    },
  };
}
