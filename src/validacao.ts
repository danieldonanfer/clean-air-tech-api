import { z } from 'zod';
import { erros } from './erros.ts';

/**
 * Regras de entrada. As mensagens são as que o front já exibe hoje (ver docs/API_CONTRATO.md) e as regras
 * de senha repetem `src/utils/senha.ts` do front: a API não pode confiar que a tela validou.
 */

const MSG_NOME = 'Nome e e-mail são obrigatórios.';
const MSG_EMAIL = 'Informe um e-mail válido.';
const MSG_TELEFONE = 'Informe um telefone válido, com DDD.';
const MSG_OBJETIVO = 'Escolha um objetivo válido.';
const MSG_TERMOS = 'É preciso aceitar os Termos de Uso.';
const MSG_SENHA_LONGA = 'A senha pode ter no máximo 128 caracteres.';

export const OBJETIVOS = ['ar', 'alergia', 'conforto', 'outro'] as const;
export type Objetivo = (typeof OBJETIVOS)[number];

const REGRAS_SENHA: { rotulo: string; testar: (s: string) => boolean }[] = [
  { rotulo: 'Mínimo de 8 caracteres', testar: (s) => s.length >= 8 },
  { rotulo: 'Letra maiúscula e minúscula', testar: (s) => /[A-Z]/.test(s) && /[a-z]/.test(s) },
  { rotulo: 'Pelo menos um número', testar: (s) => /[0-9]/.test(s) },
  { rotulo: 'Um caractere especial (!@#$)', testar: (s) => /[^A-Za-z0-9]/.test(s) },
];

/** Mensagem do primeiro requisito de senha não atendido, ou `null` se a senha é válida. */
export function problemaDaSenha(senha: string): string | null {
  if (senha.length > 128) return MSG_SENHA_LONGA;
  const falha = REGRAS_SENHA.find((r) => !r.testar(senha));
  return falha ? `A senha não atende a um requisito: ${falha.rotulo.toLowerCase()}.` : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const email = z
  .string({ error: MSG_EMAIL })
  .trim()
  .toLowerCase()
  .max(254, MSG_EMAIL)
  .regex(EMAIL, MSG_EMAIL);

const senhaNova = z.string({ error: 'Informe a senha.' }).superRefine((valor, ctx) => {
  const problema = problemaDaSenha(valor);
  if (problema) ctx.addIssue({ code: 'custom', message: problema });
});

/**
 * Telefone para E.164. Aceita máscara; sem código de país assume +55. Vazio vira `null`.
 * 10 ou 11 dígitos = DDD + número; 12 ou 13 começando em 55 = já com o país.
 */
export function normalizarTelefone(bruto: string): string | null {
  const texto = bruto.trim();
  if (!texto) return null;
  const digitos = texto.replace(/\D/g, '');
  let e164: string;
  if (texto.startsWith('+')) e164 = `+${digitos}`;
  else if (digitos.length === 10 || digitos.length === 11) e164 = `+55${digitos}`;
  else if ((digitos.length === 12 || digitos.length === 13) && digitos.startsWith('55')) e164 = `+${digitos}`;
  else throw new Error(MSG_TELEFONE);
  if (!/^\+[1-9][0-9]{6,14}$/.test(e164)) throw new Error(MSG_TELEFONE);
  return e164;
}

const telefone = z
  .string({ error: MSG_TELEFONE })
  .nullable()
  .transform((valor, ctx) => {
    try {
      return valor === null ? null : normalizarTelefone(valor);
    } catch {
      ctx.addIssue({ code: 'custom', message: MSG_TELEFONE });
      return z.NEVER;
    }
  });

export const esquemaCadastro = z.object({
  nome: z.string({ error: MSG_NOME }).trim().min(1, MSG_NOME).max(150, 'O nome é muito longo.'),
  email,
  telefone: telefone.optional(),
  senha: senhaNova,
  objetivo: z.enum(OBJETIVOS, { error: MSG_OBJETIVO }),
  aceitouTermos: z.literal(true, { error: MSG_TERMOS }),
});

export const esquemaLogin = z.object({
  email,
  senha: z.string({ error: 'Informe a senha.' }).min(1, 'Informe a senha.').max(1024, 'Informe a senha.'),
});

export const esquemaEmail = z.object({ email });

export const esquemaRedefinicao = z.object({ email, senha: senhaNova });

/** O código é só uma string; o formato errado é tratado como código inválido, não como 422. */
export const esquemaCodigo = z.object({ email, codigo: z.string().default('') });

const ORDEM = ['nome', 'email', 'telefone', 'senha', 'objetivo', 'aceitouTermos', 'corpo'];

/** Valida e devolve os dados limpos, ou lança 422 `VALIDACAO` com `campos` e a primeira mensagem. */
export function validar<T extends z.ZodType>(esquema: T, dados: unknown): z.output<T> {
  const resultado = esquema.safeParse(dados);
  if (resultado.success) return resultado.data;

  const campos: Record<string, string> = {};
  for (const problema of resultado.error.issues) {
    const campo = typeof problema.path[0] === 'string' ? problema.path[0] : 'corpo';
    campos[campo] ??= problema.message;
  }
  const primeiro = ORDEM.find((c) => campos[c]) ?? Object.keys(campos)[0] ?? 'corpo';
  throw erros.validacao(campos[primeiro] ?? 'Requisição inválida.', campos);
}

export function codigoComFormatoValido(codigo: string): boolean {
  return /^[0-9]{6}$/.test(codigo);
}
