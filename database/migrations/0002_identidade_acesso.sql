-- Up Migration

CREATE TABLE refined.usuario (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_completo              text        NOT NULL,
  email                      text        NOT NULL,
  senha_hash                 text        NOT NULL,
  telefone                   text,
  telefone_verificado        boolean     NOT NULL DEFAULT false,
  papel_usuario              text        NOT NULL DEFAULT 'padrao',
  status_conta               text        NOT NULL DEFAULT 'ativo',
  email_verificado           boolean     NOT NULL DEFAULT false,
  ultimo_login_em            timestamptz,
  senha_alterada_em          timestamptz,
  mfa_habilitado             boolean     NOT NULL DEFAULT false,
  tentativas_login_falhas    integer     NOT NULL DEFAULT 0,
  bloqueado_ate              timestamptz,
  idioma_preferido           text        NOT NULL DEFAULT 'pt-BR',
  fuso_horario               text        NOT NULL DEFAULT 'America/Sao_Paulo',
  consentimento_lgpd_aceito  boolean     NOT NULL DEFAULT false,
  consentimento_lgpd_data    timestamptz,
  termos_uso_versao_aceita   text,
  termos_uso_aceito_em       timestamptz,
  classificacao_dado         text        NOT NULL DEFAULT 'pessoal',
  retencao_dado_ate          date,
  criado_em                  timestamptz NOT NULL DEFAULT now(),
  atualizado_em              timestamptz NOT NULL DEFAULT now(),
  removido_em                timestamptz,
  CONSTRAINT ck_usuario_email CHECK (position('@' IN email) > 1),
  CONSTRAINT ck_usuario_telefone_e164 CHECK (telefone IS NULL OR telefone ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT ck_usuario_telefone_verificado CHECK (NOT telefone_verificado OR telefone IS NOT NULL),
  CONSTRAINT ck_usuario_papel CHECK (papel_usuario IN ('padrao', 'gestor')),
  CONSTRAINT ck_usuario_status CHECK (status_conta IN ('ativo', 'suspenso', 'encerrado')),
  CONSTRAINT ck_usuario_tentativas CHECK (tentativas_login_falhas >= 0),
  CONSTRAINT ck_usuario_idioma CHECK (idioma_preferido ~ '^[a-z]{2,3}(-[A-Z]{2})?$'),
  CONSTRAINT ck_usuario_fuso CHECK (refined.fuso_horario_valido(fuso_horario)),
  CONSTRAINT ck_usuario_consentimento CHECK (NOT consentimento_lgpd_aceito OR consentimento_lgpd_data IS NOT NULL),
  CONSTRAINT ck_usuario_classificacao CHECK (classificacao_dado IN ('pessoal', 'sensivel', 'publico'))
);
-- E-mail único entre contas não removidas (permite recadastro após exclusão).
CREATE UNIQUE INDEX ux_usuario_email ON refined.usuario (lower(email)) WHERE removido_em IS NULL;
CREATE UNIQUE INDEX ux_usuario_telefone ON refined.usuario (telefone) WHERE telefone IS NOT NULL AND removido_em IS NULL;

COMMENT ON TABLE refined.usuario IS 'Conta do cliente final do aplicativo.';
COMMENT ON COLUMN refined.usuario.senha_hash IS 'Hash bcrypt/argon2 gerado pela aplicação. Nunca a senha em texto.';
COMMENT ON COLUMN refined.usuario.telefone IS 'Formato E.164 (ex.: +5541999998888).';
COMMENT ON COLUMN refined.usuario.fuso_horario IS 'Nome IANA tz database (ex.: America/Sao_Paulo).';
COMMENT ON COLUMN refined.usuario.idioma_preferido IS 'Tag BCP 47 (ex.: pt-BR).';
COMMENT ON COLUMN refined.usuario.tentativas_login_falhas IS 'Força bruta: vale SOMENTE para o fluxo de login, nunca para recuperação de senha (OWASP).';
COMMENT ON COLUMN refined.usuario.retencao_dado_ate IS 'Data-limite de retenção; base do expurgo automatizado.';
COMMENT ON COLUMN refined.usuario.removido_em IS 'Exclusão lógica (soft delete).';

-- Membro da equipe interna (suporte, administração).
CREATE TABLE refined.colaborador (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome              text        NOT NULL,
  email_corporativo text        NOT NULL,
  cargo             text        NOT NULL,
  ativo             boolean     NOT NULL DEFAULT true,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_colaborador_email CHECK (position('@' IN email_corporativo) > 1)
);
CREATE UNIQUE INDEX ux_colaborador_email ON refined.colaborador (lower(email_corporativo));
COMMENT ON TABLE refined.colaborador IS 'Membro da equipe interna (suporte, administração). Separado de usuario (cliente).';

-- Token genérico: verificação de e-mail, OTP de telefone e recuperação de senha.
CREATE TABLE refined.token_verificacao (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id      uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  tipo            text        NOT NULL,
  token_hash      text        NOT NULL,
  tentativas_uso  integer     NOT NULL DEFAULT 0,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  expira_em       timestamptz NOT NULL,
  usado_em        timestamptz,
  CONSTRAINT ck_token_tipo CHECK (tipo IN ('verificacao_email', 'verificacao_telefone', 'recuperacao_senha')),
  CONSTRAINT ck_token_tentativas CHECK (tentativas_uso >= 0),
  CONSTRAINT ck_token_expiracao CHECK (expira_em > criado_em)
);
CREATE INDEX ix_token_pendente ON refined.token_verificacao (usuario_id, tipo, usado_em);
COMMENT ON TABLE refined.token_verificacao IS 'Token de uso único e expiração curta (OWASP Forgot Password; Twilio para OTP).';
COMMENT ON COLUMN refined.token_verificacao.token_hash IS 'Hash do token/código OTP. Nunca o valor original.';
COMMENT ON COLUMN refined.token_verificacao.tentativas_uso IS 'Limite de 5 tentativas para OTP, aplicado pela aplicação.';

CREATE TABLE refined.login_provedor_externo (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  provedor    text        NOT NULL,
  id_externo  text        NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_login_provedor CHECK (provedor IN ('google', 'apple', 'facebook')),
  CONSTRAINT ux_login_provedor_externo UNIQUE (provedor, id_externo),
  CONSTRAINT ux_login_provedor_usuario UNIQUE (usuario_id, provedor)
);
COMMENT ON TABLE refined.login_provedor_externo IS 'Vínculo entre a conta e um provedor de login social.';
COMMENT ON COLUMN refined.login_provedor_externo.id_externo IS 'Para apple, o claim sub do JWT. Nunca o e-mail (pode ser relay rotativo).';

CREATE TABLE refined.mfa_configuracao (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id             uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  metodo                 text        NOT NULL,
  segredo_criptografado  text        NOT NULL,
  ativo                  boolean     NOT NULL DEFAULT true,
  criado_em              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_mfa_metodo CHECK (metodo IN ('totp', 'sms')),
  CONSTRAINT ux_mfa_usuario_metodo UNIQUE (usuario_id, metodo)
);
COMMENT ON TABLE refined.mfa_configuracao IS 'Configuração de autenticação multifator do usuário.';
COMMENT ON COLUMN refined.mfa_configuracao.segredo_criptografado IS 'Segredo TOTP cifrado pela aplicação. Nunca em texto puro.';

CREATE TABLE refined.sessao_autenticacao (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id   uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  token_hash   text        NOT NULL,
  ip_origem    inet,
  user_agent   text,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  expira_em    timestamptz NOT NULL,
  revogado_em  timestamptz,
  CONSTRAINT ck_sessao_expiracao CHECK (expira_em > criado_em),
  CONSTRAINT ux_sessao_token UNIQUE (token_hash)
);
CREATE INDEX ix_sessao_usuario_expira ON refined.sessao_autenticacao (usuario_id, expira_em);
COMMENT ON TABLE refined.sessao_autenticacao IS 'Sessão de autenticação ativa do usuário no aplicativo.';

-- RBAC: três tabelas (papel, permissao, associativa), compartilhado entre cliente e equipe interna.
CREATE TABLE refined.papel (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text        NOT NULL UNIQUE,
  descricao  text,
  escopo     text        NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_papel_escopo CHECK (escopo IN ('cliente', 'interno'))
);
COMMENT ON TABLE refined.papel IS 'Papel de acesso (RBAC). escopo separa papéis de cliente e de colaborador interno.';

CREATE TABLE refined.permissao (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  chave      text        NOT NULL UNIQUE,
  descricao  text,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_permissao_chave CHECK (chave ~ '^[a-z_]+(\.[a-z_]+)*$')
);
COMMENT ON TABLE refined.permissao IS 'Permissão granular do sistema (ex.: dispositivo.gerenciar).';

CREATE TABLE refined.papel_permissao (
  papel_id      uuid NOT NULL REFERENCES refined.papel (id) ON DELETE CASCADE,
  permissao_id  uuid NOT NULL REFERENCES refined.permissao (id) ON DELETE CASCADE,
  PRIMARY KEY (papel_id, permissao_id)
);
CREATE INDEX ix_papel_permissao_permissao ON refined.papel_permissao (permissao_id);
COMMENT ON TABLE refined.papel_permissao IS 'N:M entre papel e permissao.';

CREATE TABLE refined.usuario_papel (
  usuario_id  uuid NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  papel_id    uuid NOT NULL REFERENCES refined.papel (id) ON DELETE CASCADE,
  PRIMARY KEY (usuario_id, papel_id)
);
CREATE INDEX ix_usuario_papel_papel ON refined.usuario_papel (papel_id);
COMMENT ON TABLE refined.usuario_papel IS 'N:M entre usuario e papel (apenas papéis de escopo cliente).';

CREATE TABLE refined.colaborador_papel (
  colaborador_id  uuid NOT NULL REFERENCES refined.colaborador (id) ON DELETE CASCADE,
  papel_id        uuid NOT NULL REFERENCES refined.papel (id) ON DELETE CASCADE,
  PRIMARY KEY (colaborador_id, papel_id)
);
CREATE INDEX ix_colaborador_papel_papel ON refined.colaborador_papel (papel_id);
COMMENT ON TABLE refined.colaborador_papel IS 'N:M entre colaborador e papel (apenas papéis de escopo interno).';

-- Papéis e permissões iniciais do sistema (dados de referência, não de teste).
INSERT INTO refined.papel (nome, descricao, escopo) VALUES
  ('cliente_basico',   'Usuario final com acesso aos proprios ambientes e dispositivos', 'cliente'),
  ('gestor_organizacao', 'Gestor de organizacao cliente (escola, hospital, empresa)',      'cliente'),
  ('suporte_nivel_1',  'Atendimento de primeiro nivel',                                   'interno'),
  ('suporte_nivel_2',  'Atendimento tecnico avancado',                                    'interno'),
  ('administrador',    'Administracao completa da plataforma',                            'interno');

INSERT INTO refined.permissao (chave, descricao) VALUES
  ('dispositivo.visualizar', 'Ver dispositivos e leituras'),
  ('dispositivo.gerenciar',  'Cadastrar, configurar e remover dispositivos'),
  ('alerta.visualizar',      'Ver alertas e recomendacoes'),
  ('organizacao.gerenciar',  'Gerenciar membros e ambientes da organizacao'),
  ('ticket.atender',         'Atender tickets de suporte'),
  ('ticket.escalar',         'Escalar tickets para o nivel 2'),
  ('frota.gerenciar',        'Operar firmware, grupos e feature flags da frota'),
  ('usuario.administrar',    'Suspender, reativar e auditar contas'),
  ('lgpd.atender',           'Atender solicitacoes de titular de dados');

INSERT INTO refined.papel_permissao (papel_id, permissao_id)
SELECT p.id, pe.id FROM refined.papel p
JOIN refined.permissao pe ON (p.nome, pe.chave) IN (
  ('cliente_basico', 'dispositivo.visualizar'), ('cliente_basico', 'dispositivo.gerenciar'), ('cliente_basico', 'alerta.visualizar'),
  ('gestor_organizacao', 'dispositivo.visualizar'), ('gestor_organizacao', 'dispositivo.gerenciar'),
  ('gestor_organizacao', 'alerta.visualizar'), ('gestor_organizacao', 'organizacao.gerenciar'),
  ('suporte_nivel_1', 'ticket.atender'), ('suporte_nivel_1', 'dispositivo.visualizar'), ('suporte_nivel_1', 'alerta.visualizar'),
  ('suporte_nivel_2', 'ticket.atender'), ('suporte_nivel_2', 'ticket.escalar'), ('suporte_nivel_2', 'dispositivo.visualizar'),
  ('suporte_nivel_2', 'alerta.visualizar'), ('suporte_nivel_2', 'frota.gerenciar'),
  ('administrador', 'dispositivo.visualizar'), ('administrador', 'dispositivo.gerenciar'), ('administrador', 'alerta.visualizar'),
  ('administrador', 'organizacao.gerenciar'), ('administrador', 'ticket.atender'), ('administrador', 'ticket.escalar'),
  ('administrador', 'frota.gerenciar'), ('administrador', 'usuario.administrar'), ('administrador', 'lgpd.atender')
);

-- Down Migration

DROP TABLE IF EXISTS refined.colaborador_papel;
DROP TABLE IF EXISTS refined.usuario_papel;
DROP TABLE IF EXISTS refined.papel_permissao;
DROP TABLE IF EXISTS refined.permissao;
DROP TABLE IF EXISTS refined.papel;
DROP TABLE IF EXISTS refined.sessao_autenticacao;
DROP TABLE IF EXISTS refined.mfa_configuracao;
DROP TABLE IF EXISTS refined.login_provedor_externo;
DROP TABLE IF EXISTS refined.token_verificacao;
DROP TABLE IF EXISTS refined.colaborador;
DROP TABLE IF EXISTS refined.usuario;
