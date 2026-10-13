/** Erro de regra de negócio. A `mensagem` já é a que a tela exibe, em português. */
export class ErroApi extends Error {
  constructor(
    readonly status: number,
    readonly codigo: string,
    mensagem: string,
    readonly campos?: Record<string, string>,
    readonly retryAfter?: number,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }
}

export const MENSAGEM_CODIGO_INVALIDO = 'Código inválido ou expirado.';

export const erros = {
  validacao: (mensagem: string, campos: Record<string, string>) =>
    new ErroApi(422, 'VALIDACAO', mensagem, campos),
  emailJaCadastrado: () => new ErroApi(409, 'EMAIL_JA_CADASTRADO', 'Já existe uma conta com esse e-mail.'),
  telefoneJaCadastrado: () =>
    new ErroApi(409, 'TELEFONE_JA_CADASTRADO', 'Já existe uma conta com esse telefone.'),
  credenciaisInvalidas: () => new ErroApi(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha incorretos.'),
  contaBloqueada: (minutos: number) =>
    new ErroApi(
      423,
      'CONTA_BLOQUEADA',
      `Muitas tentativas de entrada. Tente novamente em ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.`,
    ),
  contaSuspensa: () => new ErroApi(403, 'CONTA_SUSPENSA', 'Esta conta está suspensa. Fale com o suporte.'),
  sessaoInvalida: () => new ErroApi(401, 'SESSAO_INVALIDA', 'Sua sessão expirou. Entre novamente.'),
  codigoInvalido: () => new ErroApi(400, 'CODIGO_INVALIDO', MENSAGEM_CODIGO_INVALIDO),
  muitasRequisicoes: (retryAfter: number) =>
    new ErroApi(
      429,
      'MUITAS_REQUISICOES',
      'Muitas tentativas. Aguarde alguns minutos e tente de novo.',
      undefined,
      retryAfter,
    ),
  naoEncontrado: () => new ErroApi(404, 'NAO_ENCONTRADO', 'Recurso não encontrado.'),
  interno: () =>
    new ErroApi(500, 'ERRO_INTERNO', 'Não foi possível concluir agora. Tente novamente em instantes.'),
};
