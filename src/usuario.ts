import type { Cliente } from './db.ts';

/** Formato do usuário que o front espera (igual ao tipo `Usuario` do app). Ver docs/API_CONTRATO.md. */
export interface UsuarioDto {
  nome: string;
  apelido: string;
  email: string;
  telefone: string;
  funcao: string;
  idioma: string;
  membroDesde: string;
  objetivo: string;
}

const FUNCAO: Record<string, string> = {
  cliente_basico: 'Cliente',
  gestor_organizacao: 'Gestor',
};

const IDIOMA: Record<string, string> = {
  'pt-BR': 'Português (Brasil)',
  'en-US': 'English (US)',
  'es-ES': 'Español',
};

const OBJETIVO: Record<string, string> = {
  ar: 'Monitoramento de ar e poluentes',
  alergia: 'Controle de alergias e asma',
  conforto: 'Conforto e automação',
  outro: 'Outro objetivo',
};

const formatoMes = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'America/Sao_Paulo',
});

interface LinhaUsuario {
  nome_completo: string;
  email: string;
  telefone: string | null;
  idioma_preferido: string;
  criado_em: Date;
  objetivo_uso: string;
  papel: string | null;
}

export function paraDto(linha: LinhaUsuario): UsuarioDto {
  return {
    nome: linha.nome_completo,
    apelido: linha.nome_completo.trim().split(/\s+/)[0] ?? linha.nome_completo,
    email: linha.email,
    telefone: linha.telefone ?? '',
    funcao: FUNCAO[linha.papel ?? ''] ?? 'Cliente',
    idioma: IDIOMA[linha.idioma_preferido] ?? linha.idioma_preferido,
    membroDesde: formatoMes.format(linha.criado_em),
    objetivo: OBJETIVO[linha.objetivo_uso] ?? OBJETIVO.outro!,
  };
}

/**
 * Lê o usuário já com o papel de cliente. Funciona sob `clean_air_auth` e sob `clean_air_app`
 * (os dois têm SELECT nestas colunas). Papel de gestor tem prioridade sobre o básico na exibição.
 *
 * Não filtra `removido_em`: `clean_air_app` não enxerga essa coluna. Quem chama já tem um usuário
 * validado (a sessão só vale para conta ativa e não removida, ver `ServicoAuth.autenticar`).
 */
export async function lerUsuario(c: Cliente, id: string): Promise<UsuarioDto | null> {
  const { rows } = await c.query<LinhaUsuario>(
    `SELECT u.nome_completo, u.email, u.telefone, u.idioma_preferido, u.criado_em, u.objetivo_uso,
            (SELECT p.nome
               FROM refined.usuario_papel up
               JOIN refined.papel p ON p.id = up.papel_id
              WHERE up.usuario_id = u.id AND p.escopo = 'cliente'
              ORDER BY p.nome DESC
              LIMIT 1) AS papel
       FROM refined.usuario u
      WHERE u.id = $1`,
    [id],
  );
  const linha = rows[0];
  return linha ? paraDto(linha) : null;
}
