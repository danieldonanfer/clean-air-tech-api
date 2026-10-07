-- Clean Air Tech - esquema consolidado do banco de dados
-- PostgreSQL 17+ (TimescaleDB opcional: ver 0009_timescaledb_hypertable.sql)
--
-- ARQUIVO GERADO por "npm run db:schema" a partir de database/migrations/ (parte Up).
-- Para criar o banco use as migrations (npm run db:migrate); este arquivo serve para leitura e revisao.

-- =====================================================================
-- 0001_base_schemas_papeis.sql
-- =====================================================================

-- Camadas de dados (Manual BD, seção 5): raw -> refined -> trusted.
CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS refined;
CREATE SCHEMA IF NOT EXISTS trusted;

COMMENT ON SCHEMA raw IS 'Camada raw: ingestão de dado bruto, sem tratamento. Retenção curta (só reprocessamento).';
COMMENT ON SCHEMA refined IS 'Camada refined: modelo operacional normalizado (3FN), usado pela aplicação.';
COMMENT ON SCHEMA trusted IS 'Camada trusted: modelo dimensional (esquema estrela) para análise, sem dado pessoal.';

-- Papéis de serviço (privilégio mínimo, Manual BD seção 8). NOLOGIN: quem faz o deploy
-- concede LOGIN/senha fora do repositório.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['clean_air_auth', 'clean_air_app', 'clean_air_ingestao', 'clean_air_analitico']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $$;

COMMENT ON ROLE clean_air_auth IS 'Fluxos de autenticação (login, recuperação, sessão), que ocorrem antes de haver um usuário identificado.';
COMMENT ON ROLE clean_air_app IS 'API em nome de um usuário autenticado; sujeita à Row Level Security.';
COMMENT ON ROLE clean_air_ingestao IS 'Pipeline de ingestão: grava raw e leitura_sensor, gera alertas.';
COMMENT ON ROLE clean_air_analitico IS 'Consultas analíticas: somente leitura na camada trusted.';

-- Usuário da sessão corrente, informado pela API com: SET LOCAL app.usuario_id = '<uuid>'.
CREATE FUNCTION refined.usuario_atual() RETURNS uuid
LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.usuario_id', true), '')::uuid $$;

CREATE FUNCTION refined.definir_atualizado_em() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END
$$;

-- Fuso horário deve existir no banco IANA (Manual BD seção 2.2).
CREATE FUNCTION refined.fuso_horario_valido(nome text) RETURNS boolean
LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = nome) $$;

-- =====================================================================
-- 0002_identidade_acesso.sql
-- =====================================================================

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

-- =====================================================================
-- 0003_organizacao_ambientes_frota.sql
-- =====================================================================

-- ---------- Multi-organização (tenancy por tabela de vínculo) ----------
CREATE TABLE refined.organizacao (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_fantasia  text        NOT NULL,
  razao_social   text,
  tipo           text        NOT NULL,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  removido_em    timestamptz,
  CONSTRAINT ck_organizacao_tipo CHECK (tipo IN ('escola', 'hospital', 'empresa', 'outro'))
);
COMMENT ON TABLE refined.organizacao IS 'Cliente institucional (escola, hospital, empresa).';

CREATE TABLE refined.usuario_organizacao (
  usuario_id            uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  organizacao_id        uuid        NOT NULL REFERENCES refined.organizacao (id) ON DELETE CASCADE,
  papel_na_organizacao  text        NOT NULL DEFAULT 'membro',
  criado_em             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, organizacao_id),
  CONSTRAINT ck_usuario_org_papel CHECK (papel_na_organizacao IN ('membro', 'gestor', 'administrador'))
);
CREATE INDEX ix_usuario_org_organizacao ON refined.usuario_organizacao (organizacao_id);
COMMENT ON TABLE refined.usuario_organizacao IS 'Padrão membership: o usuário pertence a N organizações; não há tenant_id direto em usuario.';

-- ---------- Ambientes ----------
CREATE TABLE refined.local (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id      uuid          NOT NULL REFERENCES refined.usuario (id),
  organizacao_id  uuid          REFERENCES refined.organizacao (id),
  local_pai_id    uuid          REFERENCES refined.local (id),
  nome            text          NOT NULL,
  tipo_local      text          NOT NULL,
  latitude        numeric(9,6),
  longitude       numeric(9,6),
  fuso_horario    text          NOT NULL DEFAULT 'America/Sao_Paulo',
  ativo           boolean       NOT NULL DEFAULT true,
  criado_em       timestamptz   NOT NULL DEFAULT now(),
  atualizado_em   timestamptz   NOT NULL DEFAULT now(),
  removido_em     timestamptz,
  CONSTRAINT ck_local_tipo CHECK (tipo_local IN ('residencia', 'comodo', 'escritorio', 'outro')),
  CONSTRAINT ck_local_pai CHECK (local_pai_id IS NULL OR local_pai_id <> id),
  CONSTRAINT ck_local_latitude CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  CONSTRAINT ck_local_longitude CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  CONSTRAINT ck_local_coordenadas CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CONSTRAINT ck_local_fuso CHECK (refined.fuso_horario_valido(fuso_horario))
);
CREATE INDEX ix_local_usuario ON refined.local (usuario_id);
CREATE INDEX ix_local_organizacao ON refined.local (organizacao_id) WHERE organizacao_id IS NOT NULL;
CREATE INDEX ix_local_pai ON refined.local (local_pai_id) WHERE local_pai_id IS NOT NULL;
COMMENT ON TABLE refined.local IS 'Ambiente físico monitorado, com hierarquia (auto-relacionamento).';
COMMENT ON COLUMN refined.local.usuario_id IS 'Titular que cadastrou o ambiente.';
COMMENT ON COLUMN refined.local.organizacao_id IS 'Organização dona do ambiente, quando institucional. NULL para uso doméstico.';
COMMENT ON COLUMN refined.local.local_pai_id IS 'NULL = nível raiz. Ciclos são impedidos por gatilho.';

CREATE TABLE refined.local_membro (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id      uuid        NOT NULL REFERENCES refined.local (id) ON DELETE CASCADE,
  usuario_id    uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  nivel_acesso  text        NOT NULL DEFAULT 'visualizador',
  criado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_local_membro_nivel CHECK (nivel_acesso IN ('proprietario', 'visualizador')),
  CONSTRAINT ux_local_membro UNIQUE (local_id, usuario_id)
);
CREATE INDEX ix_local_membro_usuario ON refined.local_membro (usuario_id);
COMMENT ON TABLE refined.local_membro IS 'Quem tem acesso compartilhado ao ambiente. Distinto de dispositivo.usuario_proprietario_id (titular financeiro).';

-- ---------- Fabricação e frota ----------
CREATE TABLE refined.lote_fabricacao (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_lote          text        NOT NULL UNIQUE,
  data_fabricacao      date        NOT NULL,
  quantidade_unidades  integer     NOT NULL,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_lote_quantidade CHECK (quantidade_unidades > 0)
);
COMMENT ON TABLE refined.lote_fabricacao IS 'Lote de produção do hardware.';

CREATE TABLE refined.dispositivo (
  id                            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id                      uuid          NOT NULL REFERENCES refined.local (id),
  usuario_proprietario_id       uuid          NOT NULL REFERENCES refined.usuario (id),
  lote_fabricacao_id            uuid          REFERENCES refined.lote_fabricacao (id),
  numero_serie                  text          NOT NULL UNIQUE,
  modelo                        text          NOT NULL,
  data_ativacao                 timestamptz,
  status_dispositivo            text          NOT NULL DEFAULT 'inativo',
  status_conexao                text          NOT NULL DEFAULT 'offline',
  intervalo_captacao_segundos   integer       NOT NULL DEFAULT 60,
  ultimo_contato_em             timestamptz,
  nivel_bateria_percentual      numeric(5,2),
  intensidade_sinal_dbm         integer,
  contagem_erros_consecutivos   integer       NOT NULL DEFAULT 0,
  ultima_sincronizacao_em       timestamptz,
  firmware_versao_atual_id      uuid,
  criado_em                     timestamptz   NOT NULL DEFAULT now(),
  atualizado_em                 timestamptz   NOT NULL DEFAULT now(),
  removido_em                   timestamptz,
  CONSTRAINT ck_dispositivo_status CHECK (status_dispositivo IN ('ativo', 'inativo', 'manutencao', 'descontinuado')),
  CONSTRAINT ck_dispositivo_conexao CHECK (status_conexao IN ('online', 'offline', 'degradado')),
  CONSTRAINT ck_dispositivo_intervalo CHECK (intervalo_captacao_segundos BETWEEN 1 AND 3600),
  CONSTRAINT ck_dispositivo_bateria CHECK (nivel_bateria_percentual IS NULL OR nivel_bateria_percentual BETWEEN 0 AND 100),
  CONSTRAINT ck_dispositivo_erros CHECK (contagem_erros_consecutivos >= 0)
);
CREATE INDEX ix_dispositivo_local ON refined.dispositivo (local_id);
CREATE INDEX ix_dispositivo_proprietario ON refined.dispositivo (usuario_proprietario_id);
CREATE INDEX ix_dispositivo_lote ON refined.dispositivo (lote_fabricacao_id) WHERE lote_fabricacao_id IS NOT NULL;
CREATE INDEX ix_dispositivo_ultimo_contato ON refined.dispositivo (ultimo_contato_em) WHERE removido_em IS NULL;
COMMENT ON TABLE refined.dispositivo IS 'Unidade física de monitoramento.';
COMMENT ON COLUMN refined.dispositivo.usuario_proprietario_id IS 'Titular financeiro. Desnormalização deliberada de local.usuario_id; consistência garantida por gatilho.';
COMMENT ON COLUMN refined.dispositivo.numero_serie IS 'Identificador único gravado em fábrica; usado no pareamento.';
COMMENT ON COLUMN refined.dispositivo.intervalo_captacao_segundos IS 'Configurável de 1 s a 60 min; padrão de fábrica 60 s.';
COMMENT ON COLUMN refined.dispositivo.intensidade_sinal_dbm IS 'RSSI da última conexão.';

-- Device Shadow: configuração desejada x reportada.
CREATE TABLE refined.dispositivo_estado (
  dispositivo_id    uuid        PRIMARY KEY REFERENCES refined.dispositivo (id) ON DELETE CASCADE,
  estado_desejado   jsonb       NOT NULL DEFAULT '{}',
  estado_reportado  jsonb       NOT NULL DEFAULT '{}',
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_estado_desejado_objeto CHECK (jsonb_typeof(estado_desejado) = 'object'),
  CONSTRAINT ck_estado_reportado_objeto CHECK (jsonb_typeof(estado_reportado) = 'object')
);
COMMENT ON TABLE refined.dispositivo_estado IS 'Padrão Device Shadow (AWS IoT): configuração desejada x última confirmada pelo dispositivo. Permite configurar com o dispositivo offline.';

CREATE TABLE refined.grupo_dispositivo (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome       text        NOT NULL UNIQUE,
  criterio   jsonb       NOT NULL DEFAULT '{}',
  criado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_grupo_criterio_objeto CHECK (jsonb_typeof(criterio) = 'object')
);
COMMENT ON TABLE refined.grupo_dispositivo IS 'Grupo lógico de dispositivos para operação em lote (padrão Thing Groups).';

CREATE TABLE refined.dispositivo_grupo (
  dispositivo_id  uuid NOT NULL REFERENCES refined.dispositivo (id) ON DELETE CASCADE,
  grupo_id        uuid NOT NULL REFERENCES refined.grupo_dispositivo (id) ON DELETE CASCADE,
  PRIMARY KEY (dispositivo_id, grupo_id)
);
CREATE INDEX ix_dispositivo_grupo_grupo ON refined.dispositivo_grupo (grupo_id);
COMMENT ON TABLE refined.dispositivo_grupo IS 'N:M entre dispositivo e grupo_dispositivo.';

CREATE TABLE refined.firmware_versao (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispositivo_id        uuid        NOT NULL REFERENCES refined.dispositivo (id) ON DELETE CASCADE,
  versao_codigo         text        NOT NULL,
  origem_atualizacao    text        NOT NULL DEFAULT 'ota',
  resultado_instalacao  text        NOT NULL DEFAULT 'sucesso',
  valido_de             timestamptz NOT NULL DEFAULT now(),
  valido_ate            timestamptz,
  registro_atual        boolean     NOT NULL DEFAULT true,
  CONSTRAINT ck_firmware_origem CHECK (origem_atualizacao IN ('ota', 'manual')),
  CONSTRAINT ck_firmware_resultado CHECK (resultado_instalacao IN ('sucesso', 'falha', 'revertido')),
  CONSTRAINT ck_firmware_vigencia CHECK (valido_ate IS NULL OR valido_ate >= valido_de),
  CONSTRAINT ck_firmware_atual_sem_fim CHECK (NOT registro_atual OR valido_ate IS NULL),
  CONSTRAINT ck_firmware_atual_sucesso CHECK (NOT registro_atual OR resultado_instalacao = 'sucesso')
);
CREATE UNIQUE INDEX ux_firmware_atual ON refined.firmware_versao (dispositivo_id) WHERE registro_atual;
CREATE INDEX ix_firmware_dispositivo ON refined.firmware_versao (dispositivo_id, valido_de DESC);
COMMENT ON TABLE refined.firmware_versao IS 'Histórico de firmware por dispositivo (SCD Tipo 2). Instalação com falha/revertida é registrada, mas não vira registro_atual.';

ALTER TABLE refined.dispositivo
  ADD CONSTRAINT fk_dispositivo_firmware_atual
  FOREIGN KEY (firmware_versao_atual_id) REFERENCES refined.firmware_versao (id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX ix_dispositivo_firmware_atual ON refined.dispositivo (firmware_versao_atual_id) WHERE firmware_versao_atual_id IS NOT NULL;

CREATE TABLE refined.feature_flag (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  chave               text          NOT NULL UNIQUE,
  tipo_alvo           text          NOT NULL,
  percentual_rollout  numeric(5,2)  NOT NULL DEFAULT 0,
  criterio_alvo       jsonb         NOT NULL DEFAULT '{}',
  status              text          NOT NULL DEFAULT 'planejado',
  iniciado_em         timestamptz,
  concluido_em        timestamptz,
  criado_em           timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_flag_tipo CHECK (tipo_alvo IN ('firmware', 'modelo_ia', 'funcionalidade_app')),
  CONSTRAINT ck_flag_percentual CHECK (percentual_rollout BETWEEN 0 AND 100),
  CONSTRAINT ck_flag_status CHECK (status IN ('planejado', 'em_andamento', 'concluido', 'revertido')),
  CONSTRAINT ck_flag_criterio_objeto CHECK (jsonb_typeof(criterio_alvo) = 'object'),
  CONSTRAINT ck_flag_periodo CHECK (concluido_em IS NULL OR iniciado_em IS NULL OR concluido_em >= iniciado_em)
);
COMMENT ON TABLE refined.feature_flag IS 'Rollout gradual e reversível de firmware, modelo de IA ou funcionalidade do app.';

CREATE TABLE refined.certificacao_dispositivo (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  modelo             text        NOT NULL,
  tipo_certificacao  text        NOT NULL,
  laboratorio        text        NOT NULL,
  validade_ate       date        NOT NULL,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_certificacao_tipo CHECK (tipo_certificacao IN ('anatel', 'ce', 'fcc', 'rohs', 'weee'))
);
CREATE INDEX ix_certificacao_modelo ON refined.certificacao_dispositivo (modelo, tipo_certificacao);
COMMENT ON TABLE refined.certificacao_dispositivo IS 'Certificações regulatórias obrigatórias por modelo de hardware (RF.11 de hardware).';

CREATE TABLE refined.garantia_dispositivo (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispositivo_id      uuid        NOT NULL REFERENCES refined.dispositivo (id) ON DELETE CASCADE,
  data_compra         date        NOT NULL,
  data_fim_garantia   date        NOT NULL,
  canal_venda         text,
  numero_nota_fiscal  text,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_garantia_periodo CHECK (data_fim_garantia >= data_compra)
);
CREATE INDEX ix_garantia_dispositivo ON refined.garantia_dispositivo (dispositivo_id);
COMMENT ON TABLE refined.garantia_dispositivo IS 'Períodos de garantia. 1:N com dispositivo: uma troca por RMA gera novo registro.';

-- =====================================================================
-- 0004_leituras_ia_alertas.sql
-- =====================================================================

CREATE TABLE refined.modelo_ia_versao (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_modelo     text        NOT NULL,
  versao_codigo   text        NOT NULL,
  valido_de       timestamptz NOT NULL DEFAULT now(),
  valido_ate      timestamptz,
  registro_atual  boolean     NOT NULL DEFAULT true,
  criado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_modelo_ia_vigencia CHECK (valido_ate IS NULL OR valido_ate >= valido_de),
  CONSTRAINT ck_modelo_ia_atual_sem_fim CHECK (NOT registro_atual OR valido_ate IS NULL)
);
CREATE UNIQUE INDEX ux_modelo_ia_atual ON refined.modelo_ia_versao (nome_modelo) WHERE registro_atual;
CREATE INDEX ix_modelo_ia_historico ON refined.modelo_ia_versao (nome_modelo, valido_de DESC);
COMMENT ON TABLE refined.modelo_ia_versao IS 'Histórico de versões dos modelos de IA/ML (SCD Tipo 2). Rollback = novo período de vigência da versão anterior (refined.reverter_modelo_ia), preservando o histórico (RNF 20.1).';
COMMENT ON COLUMN refined.modelo_ia_versao.nome_modelo IS 'Ex.: recomendacao_qualidade_ar, classificador_evento_sonoro.';

-- Série temporal de altíssimo volume. Vira hypertable na migration 0009 (TimescaleDB).
CREATE TABLE refined.leitura_sensor (
  dispositivo_id        uuid          NOT NULL REFERENCES refined.dispositivo (id),
  medido_em             timestamptz   NOT NULL,
  pm1_microg_m3         numeric(6,2),
  pm25_microg_m3        numeric(6,2),
  pm10_microg_m3        numeric(6,2),
  no2_ppm               numeric(6,3),
  tvoc_indice           numeric(6,2),
  co2_ppm               numeric(7,2),
  co_ppm                numeric(6,2),
  o3_ppm                numeric(6,3),
  temperatura_celsius   numeric(5,2),
  umidade_percentual    numeric(5,2),
  pressao_hpa           numeric(6,2),
  indice_uv             numeric(4,2),
  origem_dado           text          NOT NULL,
  score_qualidade       numeric(3,2),
  validado              boolean       NOT NULL DEFAULT false,
  lote_ingestao_id      uuid,
  criado_em             timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (dispositivo_id, medido_em),
  CONSTRAINT ck_leitura_origem CHECK (origem_dado IN ('wifi', 'bluetooth', 'lora', 'gsm')),
  CONSTRAINT ck_leitura_particulas CHECK (
    (pm1_microg_m3 IS NULL OR pm1_microg_m3 >= 0) AND
    (pm25_microg_m3 IS NULL OR pm25_microg_m3 >= 0) AND
    (pm10_microg_m3 IS NULL OR pm10_microg_m3 >= 0)),
  CONSTRAINT ck_leitura_gases CHECK (
    (no2_ppm IS NULL OR no2_ppm >= 0) AND (tvoc_indice IS NULL OR tvoc_indice >= 0) AND
    (co2_ppm IS NULL OR co2_ppm >= 0) AND (co_ppm IS NULL OR co_ppm >= 0) AND (o3_ppm IS NULL OR o3_ppm >= 0)),
  CONSTRAINT ck_leitura_temperatura CHECK (temperatura_celsius IS NULL OR temperatura_celsius BETWEEN -50 AND 100),
  CONSTRAINT ck_leitura_umidade CHECK (umidade_percentual IS NULL OR umidade_percentual BETWEEN 0 AND 100),
  CONSTRAINT ck_leitura_pressao CHECK (pressao_hpa IS NULL OR pressao_hpa BETWEEN 300 AND 1100),
  CONSTRAINT ck_leitura_uv CHECK (indice_uv IS NULL OR indice_uv BETWEEN 0 AND 20),
  CONSTRAINT ck_leitura_score CHECK (score_qualidade IS NULL OR score_qualidade BETWEEN 0 AND 1)
);
COMMENT ON TABLE refined.leitura_sensor IS 'Medição ambiental. Hypertable TimescaleDB particionada por medido_em; PK composta alinhada ao particionamento.';
COMMENT ON COLUMN refined.leitura_sensor.pressao_hpa IS 'Faixa do sensor: 300 a 1100 hPa (RF de hardware).';
COMMENT ON COLUMN refined.leitura_sensor.origem_dado IS 'Via de conectividade: wifi, bluetooth, lora ou gsm.';
COMMENT ON COLUMN refined.leitura_sensor.score_qualidade IS '0 a 1: confiança na leitura (calibração, drift, outliers).';
COMMENT ON COLUMN refined.leitura_sensor.lote_ingestao_id IS 'Rastreabilidade lógica com raw.lote_ingestao (sem FK: a camada raw é expurgada).';

CREATE TABLE refined.evento_sonoro_detectado (
  id                       uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  dispositivo_id           uuid          NOT NULL REFERENCES refined.dispositivo (id),
  detectado_em             timestamptz   NOT NULL,
  categoria_evento         text          NOT NULL,
  confianca_classificacao  numeric(3,2)  NOT NULL,
  modelo_ia_versao_id      uuid          NOT NULL REFERENCES refined.modelo_ia_versao (id),
  criado_em                timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_evento_categoria CHECK (categoria_evento IN ('cozinha', 'aspirador', 'chuva', 'trovao', 'outro')),
  CONSTRAINT ck_evento_confianca CHECK (confianca_classificacao BETWEEN 0 AND 1)
);
CREATE INDEX ix_evento_dispositivo_tempo ON refined.evento_sonoro_detectado (dispositivo_id, detectado_em DESC);
CREATE INDEX ix_evento_modelo ON refined.evento_sonoro_detectado (modelo_ia_versao_id);
COMMENT ON TABLE refined.evento_sonoro_detectado IS 'Classificação de evento sonoro por TinyML local (cozinha, aspirador, chuva, trovão). Não armazena áudio.';

CREATE TABLE refined.alerta (
  id                      uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  dispositivo_id          uuid          NOT NULL REFERENCES refined.dispositivo (id),
  usuario_id              uuid          NOT NULL REFERENCES refined.usuario (id),
  medido_em_referencia    timestamptz   NOT NULL,
  tipo_alerta             text          NOT NULL,
  nivel_severidade        text          NOT NULL,
  valor_medido            numeric(8,2)  NOT NULL,
  limiar_referencia       numeric(8,2)  NOT NULL,
  status_principal        text          NOT NULL DEFAULT 'aberto',
  status_anterior         text,
  status_alterado_em      timestamptz,
  criado_em               timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_alerta_tipo CHECK (tipo_alerta IN (
    'pm25_alto', 'pm10_alto', 'co2_alto', 'co_alto', 'o3_alto', 'no2_alto',
    'tvoc_alto', 'uv_alto', 'temperatura_fora_faixa', 'umidade_fora_faixa')),
  CONSTRAINT ck_alerta_severidade CHECK (nivel_severidade IN ('info', 'atencao', 'critico')),
  CONSTRAINT ck_alerta_status CHECK (status_principal IN ('aberto', 'reconhecido', 'resolvido'))
);
CREATE INDEX ix_alerta_usuario_status ON refined.alerta (usuario_id, status_principal);
CREATE INDEX ix_alerta_dispositivo_tempo ON refined.alerta (dispositivo_id, medido_em_referencia DESC);
COMMENT ON TABLE refined.alerta IS 'Evento derivado de leitura que ultrapassa limiar. Sem FK para leitura_sensor (hypertable): referência por (dispositivo_id, medido_em_referencia).';
COMMENT ON COLUMN refined.alerta.tipo_alerta IS 'Cobre todas as grandezas monitoradas; além das cinco do manual, inclui pm10, no2, tvoc, uv e temperatura.';

CREATE TABLE refined.recomendacao (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  alerta_id            uuid        NOT NULL REFERENCES refined.alerta (id) ON DELETE CASCADE,
  texto_recomendacao   text        NOT NULL,
  categoria_acao       text        NOT NULL,
  fonte_geracao        text        NOT NULL DEFAULT 'regra_fixa',
  modelo_ia_versao_id  uuid        REFERENCES refined.modelo_ia_versao (id),
  aceita_pelo_usuario  boolean,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_recomendacao_categoria CHECK (categoria_acao IN ('ventilacao', 'purificacao', 'manutencao', 'outro')),
  CONSTRAINT ck_recomendacao_fonte CHECK (fonte_geracao IN ('regra_fixa', 'modelo_preditivo')),
  CONSTRAINT ck_recomendacao_modelo CHECK ((fonte_geracao = 'modelo_preditivo') = (modelo_ia_versao_id IS NOT NULL))
);
CREATE INDEX ix_recomendacao_alerta ON refined.recomendacao (alerta_id);
CREATE INDEX ix_recomendacao_modelo ON refined.recomendacao (modelo_ia_versao_id) WHERE modelo_ia_versao_id IS NOT NULL;
COMMENT ON TABLE refined.recomendacao IS 'Ação sugerida ao usuário a partir de um alerta. aceita_pelo_usuario alimenta o aprendizado do modelo.';
COMMENT ON COLUMN refined.recomendacao.modelo_ia_versao_id IS 'Preenchido se, e somente se, fonte_geracao = modelo_preditivo.';

CREATE TABLE refined.notificacao_enviada (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  alerta_id         uuid        NOT NULL REFERENCES refined.alerta (id) ON DELETE CASCADE,
  canal_envio       text        NOT NULL,
  status_principal  text        NOT NULL DEFAULT 'pendente',
  enviado_em        timestamptz,
  lido_em           timestamptz,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_notificacao_canal CHECK (canal_envio IN ('push', 'email', 'sms')),
  CONSTRAINT ck_notificacao_status CHECK (status_principal IN ('pendente', 'enviada', 'falha', 'lida')),
  CONSTRAINT ux_notificacao_destinatario UNIQUE (alerta_id, usuario_id, canal_envio)
);
CREATE INDEX ix_notificacao_usuario ON refined.notificacao_enviada (usuario_id, status_principal);
COMMENT ON TABLE refined.notificacao_enviada IS 'Uma linha por destinatário e canal.';

CREATE TABLE refined.preferencia_notificacao (
  usuario_id              uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  tipo_alerta             text        NOT NULL,
  canal                   text        NOT NULL,
  ativo                   boolean     NOT NULL DEFAULT true,
  horario_silencio_inicio time,
  horario_silencio_fim    time,
  PRIMARY KEY (usuario_id, tipo_alerta, canal),
  CONSTRAINT ck_preferencia_canal CHECK (canal IN ('push', 'email', 'sms')),
  CONSTRAINT ck_preferencia_tipo CHECK (tipo_alerta IN (
    'pm25_alto', 'pm10_alto', 'co2_alto', 'co_alto', 'o3_alto', 'no2_alto',
    'tvoc_alto', 'uv_alto', 'temperatura_fora_faixa', 'umidade_fora_faixa')),
  CONSTRAINT ck_preferencia_silencio CHECK ((horario_silencio_inicio IS NULL) = (horario_silencio_fim IS NULL))
);
COMMENT ON TABLE refined.preferencia_notificacao IS 'Preferência por usuário, tipo de alerta e canal; permite modo silencioso por horário.';

-- =====================================================================
-- 0005_negocio_suporte_governanca.sql
-- =====================================================================

CREATE TABLE refined.assinatura_plano (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id           uuid        NOT NULL REFERENCES refined.usuario (id),
  nivel_plano          text        NOT NULL DEFAULT 'gratuito',
  status_pagamento     text        NOT NULL DEFAULT 'ativo',
  limite_dispositivos  integer     NOT NULL DEFAULT 1,
  data_inicio          date        NOT NULL DEFAULT current_date,
  data_fim             date,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  atualizado_em        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_assinatura_nivel CHECK (nivel_plano IN ('gratuito', 'pro', 'enterprise')),
  CONSTRAINT ck_assinatura_pagamento CHECK (status_pagamento IN ('ativo', 'atrasado', 'cancelado')),
  CONSTRAINT ck_assinatura_limite CHECK (limite_dispositivos >= 1),
  CONSTRAINT ck_assinatura_periodo CHECK (data_fim IS NULL OR data_fim >= data_inicio)
);
-- Uma assinatura vigente (sem data_fim) por usuário; o histórico fica nas encerradas.
CREATE UNIQUE INDEX ux_assinatura_vigente ON refined.assinatura_plano (usuario_id) WHERE data_fim IS NULL;
COMMENT ON TABLE refined.assinatura_plano IS 'Nível de assinatura do usuário. Mantém histórico; apenas uma vigente por usuário.';
COMMENT ON COLUMN refined.assinatura_plano.limite_dispositivos IS 'Aplicado pela aplicação no pareamento; o banco apenas registra.';

-- Histórico de cálculos de saúde da conta (a vigente é a mais recente).
CREATE TABLE refined.saude_conta (
  id                  uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id          uuid          NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  pontuacao_saude     numeric(5,2)  NOT NULL,
  risco_cancelamento  text          NOT NULL,
  calculado_em        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_saude_pontuacao CHECK (pontuacao_saude BETWEEN 0 AND 100),
  CONSTRAINT ck_saude_risco CHECK (risco_cancelamento IN ('baixo', 'medio', 'alto'))
);
CREATE INDEX ix_saude_usuario_calculo ON refined.saude_conta (usuario_id, calculado_em DESC);
COMMENT ON TABLE refined.saude_conta IS 'Engajamento e risco de cancelamento, recalculados periodicamente por processo analítico externo. Guarda histórico.';

CREATE VIEW refined.v_saude_conta_atual AS
SELECT DISTINCT ON (usuario_id) usuario_id, pontuacao_saude, risco_cancelamento, calculado_em
FROM refined.saude_conta
ORDER BY usuario_id, calculado_em DESC;
COMMENT ON VIEW refined.v_saude_conta_atual IS 'Última saúde calculada de cada conta.';

CREATE TABLE refined.ticket_suporte (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id              uuid        NOT NULL REFERENCES refined.usuario (id),
  dispositivo_id          uuid        REFERENCES refined.dispositivo (id),
  atendente_id            uuid        REFERENCES refined.colaborador (id),
  assunto                 text        NOT NULL,
  categoria_atendimento   text        NOT NULL,
  prioridade              text        NOT NULL DEFAULT 'normal',
  status_principal        text        NOT NULL DEFAULT 'aberto',
  canal_contato           text        NOT NULL DEFAULT 'app',
  sla_limite_em           timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  sla_violado             boolean     NOT NULL DEFAULT false,
  nivel_satisfacao        integer,
  criado_em               timestamptz NOT NULL DEFAULT now(),
  atualizado_em           timestamptz NOT NULL DEFAULT now(),
  resolvido_em            timestamptz,
  CONSTRAINT ck_ticket_categoria CHECK (categoria_atendimento IN ('tecnico', 'financeiro', 'duvida')),
  CONSTRAINT ck_ticket_prioridade CHECK (prioridade IN ('baixa', 'normal', 'alta', 'urgente')),
  CONSTRAINT ck_ticket_status CHECK (status_principal IN ('aberto', 'em_andamento', 'resolvido', 'fechado')),
  CONSTRAINT ck_ticket_canal CHECK (canal_contato IN ('app', 'email', 'telefone')),
  CONSTRAINT ck_ticket_satisfacao CHECK (nivel_satisfacao IS NULL OR nivel_satisfacao BETWEEN 1 AND 5),
  CONSTRAINT ck_ticket_resolucao CHECK ((status_principal IN ('resolvido', 'fechado')) = (resolvido_em IS NOT NULL))
);
CREATE INDEX ix_ticket_sla ON refined.ticket_suporte (sla_limite_em, status_principal);
CREATE INDEX ix_ticket_usuario ON refined.ticket_suporte (usuario_id);
CREATE INDEX ix_ticket_atendente ON refined.ticket_suporte (atendente_id) WHERE atendente_id IS NOT NULL;
CREATE INDEX ix_ticket_dispositivo ON refined.ticket_suporte (dispositivo_id) WHERE dispositivo_id IS NOT NULL;
COMMENT ON TABLE refined.ticket_suporte IS 'Atendimento ao usuário com controle de SLA (RNF 19.1).';
COMMENT ON COLUMN refined.ticket_suporte.sla_limite_em IS 'Padrão: 24 horas corridas. A regra de "horas úteis" fica na aplicação, que informa o prazo real.';
COMMENT ON COLUMN refined.ticket_suporte.sla_violado IS 'Mantido por gatilho a cada escrita; para tickets parados use refined.marcar_slas_violados().';

CREATE TABLE refined.integracao_externa (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id               uuid        NOT NULL REFERENCES refined.usuario (id) ON DELETE CASCADE,
  servico_terceiro         text        NOT NULL,
  chave_api_externa        text        NOT NULL,
  escopo_permissao         jsonb       NOT NULL DEFAULT '{}',
  status_principal         text        NOT NULL DEFAULT 'ativo',
  ultima_sincronizacao_em  timestamptz,
  criado_em                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_integracao_servico CHECK (servico_terceiro IN ('ifttt', 'alexa', 'google_home', 'home_assistant')),
  CONSTRAINT ck_integracao_status CHECK (status_principal IN ('ativo', 'revogado', 'expirado')),
  CONSTRAINT ck_integracao_escopo_objeto CHECK (jsonb_typeof(escopo_permissao) = 'object')
);
CREATE INDEX ix_integracao_usuario ON refined.integracao_externa (usuario_id, servico_terceiro);
COMMENT ON TABLE refined.integracao_externa IS 'Vínculo com serviço de automação de terceiros (OAuth2 com consentimento, RF.04 de software).';
COMMENT ON COLUMN refined.integracao_externa.chave_api_externa IS 'Token/chave cifrado pela aplicação.';

CREATE TABLE refined.log_auditoria (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tabela_afetada       text        NOT NULL,
  registro_id          text,
  operacao             text        NOT NULL,
  usuario_executor_id  uuid,
  dado_anterior        jsonb,
  dado_novo            jsonb,
  origem_execucao      text        NOT NULL DEFAULT 'aplicacao',
  executado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_auditoria_operacao CHECK (operacao IN ('insert', 'update', 'delete')),
  CONSTRAINT ck_auditoria_origem CHECK (origem_execucao IN ('aplicacao', 'trigger', 'admin'))
);
CREATE INDEX ix_auditoria_registro ON refined.log_auditoria (tabela_afetada, registro_id);
CREATE INDEX ix_auditoria_executado_em ON refined.log_auditoria (executado_em DESC);
CREATE INDEX ix_auditoria_executor ON refined.log_auditoria (usuario_executor_id) WHERE usuario_executor_id IS NOT NULL;
COMMENT ON TABLE refined.log_auditoria IS 'Trilha central de auditoria. Somente inserção: gatilho impede UPDATE e DELETE.';
COMMENT ON COLUMN refined.log_auditoria.dado_anterior IS 'Estado anterior da linha, sem colunas sensíveis (hashes, segredos, chaves).';

CREATE TABLE refined.solicitacao_titular_dados (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        uuid        NOT NULL REFERENCES refined.usuario (id),
  tipo_solicitacao  text        NOT NULL,
  status            text        NOT NULL DEFAULT 'aberta',
  prazo_resposta    timestamptz NOT NULL DEFAULT (now() + interval '15 days'),
  resolvido_em      timestamptz,
  criado_em         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_solicitacao_tipo CHECK (tipo_solicitacao IN ('acesso', 'correcao', 'exclusao', 'portabilidade')),
  CONSTRAINT ck_solicitacao_status CHECK (status IN ('aberta', 'em_andamento', 'concluida')),
  CONSTRAINT ck_solicitacao_resolucao CHECK ((status = 'concluida') = (resolvido_em IS NOT NULL))
);
CREATE INDEX ix_solicitacao_usuario ON refined.solicitacao_titular_dados (usuario_id);
CREATE INDEX ix_solicitacao_prazo ON refined.solicitacao_titular_dados (prazo_resposta) WHERE status <> 'concluida';
COMMENT ON TABLE refined.solicitacao_titular_dados IS 'Pedido formal do titular sob a LGPD (acesso, correção, exclusão, portabilidade).';
COMMENT ON COLUMN refined.solicitacao_titular_dados.prazo_resposta IS 'Padrão: 15 dias (LGPD art. 19, II).';

-- =====================================================================
-- 0006_camadas_raw_trusted.sql
-- =====================================================================

-- =====================================================================
-- RAW: dado bruto como chegou do dispositivo. Retenção curta.
-- =====================================================================
CREATE TABLE raw.lote_ingestao (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  origem                  text        NOT NULL,
  sincronizacao_offline   boolean     NOT NULL DEFAULT false,
  recebido_em             timestamptz NOT NULL DEFAULT now(),
  quantidade_registros    integer     NOT NULL DEFAULT 0,
  status                  text        NOT NULL DEFAULT 'recebido',
  processado_em           timestamptz,
  CONSTRAINT ck_lote_origem CHECK (origem IN ('wifi', 'bluetooth', 'lora', 'gsm')),
  CONSTRAINT ck_lote_status CHECK (status IN ('recebido', 'processado', 'falha')),
  CONSTRAINT ck_lote_quantidade CHECK (quantidade_registros >= 0)
);
COMMENT ON TABLE raw.lote_ingestao IS 'Lote recebido. sincronizacao_offline = true quando o dispositivo despejou o buffer do microSD após ficar sem conectividade.';

CREATE TABLE raw.leitura_bruta (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lote_ingestao_id  uuid        NOT NULL REFERENCES raw.lote_ingestao (id) ON DELETE CASCADE,
  numero_serie      text        NOT NULL,
  medido_em         timestamptz NOT NULL,
  payload           jsonb       NOT NULL,
  recebido_em       timestamptz NOT NULL DEFAULT now(),
  processado_em     timestamptz,
  erro              text,
  CONSTRAINT ck_bruta_payload_objeto CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX ix_bruta_pendente ON raw.leitura_bruta (id) WHERE processado_em IS NULL;
CREATE INDEX ix_bruta_lote ON raw.leitura_bruta (lote_ingestao_id);
CREATE INDEX ix_bruta_recebido ON raw.leitura_bruta (recebido_em);
COMMENT ON TABLE raw.leitura_bruta IS 'Leitura como enviada. payload usa os nomes das colunas de refined.leitura_sensor (pm25_microg_m3, co2_ppm...) e origem_dado.';
COMMENT ON COLUMN raw.leitura_bruta.erro IS 'Motivo da rejeição na carga para refined; NULL se carregada.';

-- raw -> refined: deduplicação + carga incremental. Linha inválida não derruba o lote.
CREATE FUNCTION refined.carregar_leituras_do_raw(p_limite integer DEFAULT 5000)
RETURNS TABLE (inseridas integer, duplicadas integer, rejeitadas integer)
LANGUAGE plpgsql AS
$$
DECLARE
  r record;
  v_linhas integer;
BEGIN
  inseridas := 0; duplicadas := 0; rejeitadas := 0;

  FOR r IN
    SELECT b.id, b.lote_ingestao_id, b.medido_em, b.payload, d.id AS dispositivo_id, l.origem AS origem_lote
    FROM raw.leitura_bruta b
    JOIN raw.lote_ingestao l ON l.id = b.lote_ingestao_id
    LEFT JOIN refined.dispositivo d ON d.numero_serie = b.numero_serie AND d.removido_em IS NULL
    WHERE b.processado_em IS NULL
    ORDER BY b.id
    LIMIT p_limite
    FOR UPDATE OF b SKIP LOCKED
  LOOP
    IF r.dispositivo_id IS NULL THEN
      UPDATE raw.leitura_bruta SET processado_em = now(), erro = 'dispositivo_desconhecido' WHERE id = r.id;
      rejeitadas := rejeitadas + 1;
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO refined.leitura_sensor (
        dispositivo_id, medido_em, pm1_microg_m3, pm25_microg_m3, pm10_microg_m3, no2_ppm, tvoc_indice,
        co2_ppm, co_ppm, o3_ppm, temperatura_celsius, umidade_percentual, pressao_hpa, indice_uv,
        origem_dado, lote_ingestao_id)
      VALUES (
        r.dispositivo_id, r.medido_em,
        (r.payload ->> 'pm1_microg_m3')::numeric, (r.payload ->> 'pm25_microg_m3')::numeric,
        (r.payload ->> 'pm10_microg_m3')::numeric, (r.payload ->> 'no2_ppm')::numeric,
        (r.payload ->> 'tvoc_indice')::numeric, (r.payload ->> 'co2_ppm')::numeric,
        (r.payload ->> 'co_ppm')::numeric, (r.payload ->> 'o3_ppm')::numeric,
        (r.payload ->> 'temperatura_celsius')::numeric, (r.payload ->> 'umidade_percentual')::numeric,
        (r.payload ->> 'pressao_hpa')::numeric, (r.payload ->> 'indice_uv')::numeric,
        coalesce(r.payload ->> 'origem_dado', r.origem_lote), r.lote_ingestao_id)
      ON CONFLICT (dispositivo_id, medido_em) DO NOTHING;
      GET DIAGNOSTICS v_linhas = ROW_COUNT;

      UPDATE raw.leitura_bruta SET processado_em = now(), erro = NULL WHERE id = r.id;
      IF v_linhas = 1 THEN inseridas := inseridas + 1; ELSE duplicadas := duplicadas + 1; END IF;
    EXCEPTION WHEN check_violation OR invalid_text_representation OR numeric_value_out_of_range THEN
      UPDATE raw.leitura_bruta SET processado_em = now(), erro = SQLERRM WHERE id = r.id;
      rejeitadas := rejeitadas + 1;
    END;
  END LOOP;

  RETURN NEXT;
END
$$;
COMMENT ON FUNCTION refined.carregar_leituras_do_raw IS 'raw -> refined. ON CONFLICT DO NOTHING deduplica por (dispositivo, instante) e funciona em hypertable. Linhas inválidas são marcadas com erro, sem abortar o lote.';

-- =====================================================================
-- TRUSTED: esquema estrela (Kimball). Sem dado pessoal.
-- =====================================================================
CREATE TABLE trusted.dim_tempo (
  tempo_key      date     PRIMARY KEY,
  ano            smallint NOT NULL,
  trimestre      smallint NOT NULL,
  mes            smallint NOT NULL,
  nome_mes       text     NOT NULL,
  semana_iso     smallint NOT NULL,
  dia_do_mes     smallint NOT NULL,
  dia_da_semana  smallint NOT NULL,
  nome_dia       text     NOT NULL,
  fim_de_semana  boolean  NOT NULL,
  feriado        boolean  NOT NULL DEFAULT false,
  nome_feriado   text,
  CONSTRAINT ck_dim_tempo_dia_semana CHECK (dia_da_semana BETWEEN 1 AND 7)
);
COMMENT ON TABLE trusted.dim_tempo IS 'Calendário. dia_da_semana: 1 = segunda ... 7 = domingo (ISO 8601). Feriados preenchidos pela operação.';

CREATE FUNCTION trusted.carregar_dim_tempo(p_inicio date, p_fim date) RETURNS integer
LANGUAGE plpgsql AS
$$
DECLARE v_linhas integer;
BEGIN
  INSERT INTO trusted.dim_tempo (tempo_key, ano, trimestre, mes, nome_mes, semana_iso, dia_do_mes, dia_da_semana, nome_dia, fim_de_semana)
  SELECT d::date,
         extract(year FROM d), extract(quarter FROM d), extract(month FROM d),
         (ARRAY['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'])[extract(month FROM d)::int],
         extract(week FROM d), extract(day FROM d), extract(isodow FROM d),
         (ARRAY['segunda','terca','quarta','quinta','sexta','sabado','domingo'])[extract(isodow FROM d)::int],
         extract(isodow FROM d) IN (6, 7)
  FROM generate_series(p_inicio::timestamp, p_fim::timestamp, interval '1 day') AS d
  ON CONFLICT (tempo_key) DO NOTHING;
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  RETURN v_linhas;
END
$$;

CREATE TABLE trusted.dim_local (
  local_key         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  local_id          uuid        NOT NULL UNIQUE,
  tipo_local        text        NOT NULL,
  nivel_hierarquia  smallint    NOT NULL,
  tipo_organizacao  text,
  fuso_horario      text        NOT NULL,
  carregado_em      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE trusted.dim_local IS 'Dimensão de ambiente. Propositalmente sem nome nem coordenadas (poderiam identificar o titular).';
COMMENT ON COLUMN trusted.dim_local.local_id IS 'Chave de negócio (refined.local.id).';

CREATE TABLE trusted.dim_dispositivo (
  dispositivo_key   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dispositivo_id    uuid        NOT NULL,
  numero_serie      text        NOT NULL,
  modelo            text        NOT NULL,
  versao_firmware   text,
  valido_de         timestamptz NOT NULL,
  valido_ate        timestamptz,
  registro_atual    boolean     NOT NULL DEFAULT true,
  CONSTRAINT ck_dim_disp_vigencia CHECK (valido_ate IS NULL OR valido_ate >= valido_de),
  CONSTRAINT ck_dim_disp_atual_sem_fim CHECK (NOT registro_atual OR valido_ate IS NULL)
);
CREATE UNIQUE INDEX ux_dim_dispositivo_atual ON trusted.dim_dispositivo (dispositivo_id) WHERE registro_atual;
CREATE INDEX ix_dim_dispositivo_vigencia ON trusted.dim_dispositivo (dispositivo_id, valido_de);
COMMENT ON TABLE trusted.dim_dispositivo IS 'Dimensão de dispositivo, SCD Tipo 2 sobre a versão de firmware.';
COMMENT ON COLUMN trusted.dim_dispositivo.dispositivo_key IS 'Chave substituta; cada versão de firmware gera uma nova.';
COMMENT ON COLUMN trusted.dim_dispositivo.valido_de IS 'A primeira versão vale desde -infinity: o dispositivo pode gravar no microSD antes do pareamento e sincronizar leituras anteriores ao cadastro.';

CREATE TABLE trusted.fato_leitura (
  dispositivo_key      uuid      NOT NULL REFERENCES trusted.dim_dispositivo (dispositivo_key),
  tempo_key            date      NOT NULL REFERENCES trusted.dim_tempo (tempo_key),
  hora_do_dia          smallint  NOT NULL,
  local_key            uuid      NOT NULL REFERENCES trusted.dim_local (local_key),
  pm25_medio           numeric(6,2),
  pm25_maximo          numeric(6,2),
  co2_medio            numeric(7,2),
  quantidade_leituras  integer   NOT NULL,
  quantidade_alertas   integer   NOT NULL DEFAULT 0,
  PRIMARY KEY (dispositivo_key, tempo_key, hora_do_dia),
  CONSTRAINT ck_fato_hora CHECK (hora_do_dia BETWEEN 0 AND 23),
  CONSTRAINT ck_fato_quantidades CHECK (quantidade_leituras > 0 AND quantidade_alertas >= 0)
);
CREATE INDEX ix_fato_tempo ON trusted.fato_leitura (tempo_key, hora_do_dia);
CREATE INDEX ix_fato_local ON trusted.fato_leitura (local_key);
COMMENT ON TABLE trusted.fato_leitura IS 'Fato com granularidade HORÁRIA por dispositivo. tempo_key e hora_do_dia em UTC.';
COMMENT ON COLUMN trusted.fato_leitura.hora_do_dia IS 'Hora cheia (0 a 23, UTC). Acrescentada ao desenho original, cuja chave de tempo era apenas DATE e não sustentava a granularidade horária.';

CREATE FUNCTION trusted.carregar_dim_local() RETURNS integer
LANGUAGE plpgsql AS
$$
DECLARE v_linhas integer;
BEGIN
  WITH RECURSIVE arvore AS (
    SELECT l.id, 1 AS nivel FROM refined.local l WHERE l.local_pai_id IS NULL
    UNION ALL
    SELECT f.id, a.nivel + 1 FROM refined.local f JOIN arvore a ON f.local_pai_id = a.id
  )
  INSERT INTO trusted.dim_local (local_id, tipo_local, nivel_hierarquia, tipo_organizacao, fuso_horario)
  SELECT l.id, l.tipo_local, a.nivel, o.tipo, l.fuso_horario
  FROM refined.local l
  JOIN arvore a ON a.id = l.id
  LEFT JOIN refined.organizacao o ON o.id = l.organizacao_id
  ON CONFLICT (local_id) DO UPDATE
    SET tipo_local = EXCLUDED.tipo_local, nivel_hierarquia = EXCLUDED.nivel_hierarquia,
        tipo_organizacao = EXCLUDED.tipo_organizacao, fuso_horario = EXCLUDED.fuso_horario,
        carregado_em = now();
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  RETURN v_linhas;
END
$$;

-- SCD Tipo 2: fecha a versão vigente quando o firmware muda e abre outra.
CREATE FUNCTION trusted.carregar_dim_dispositivo() RETURNS integer
LANGUAGE plpgsql AS
$$
DECLARE v_linhas integer;
BEGIN
  WITH s AS (
    SELECT d.id AS dispositivo_id, f.versao_codigo AS versao_firmware, f.valido_de AS desde
    FROM refined.dispositivo d
    LEFT JOIN refined.firmware_versao f ON f.id = d.firmware_versao_atual_id
  )
  UPDATE trusted.dim_dispositivo t
     SET valido_ate = coalesce(s.desde, now()), registro_atual = false
    FROM s
   WHERE t.dispositivo_id = s.dispositivo_id AND t.registro_atual
     AND t.versao_firmware IS DISTINCT FROM s.versao_firmware;

  WITH s AS (
    SELECT d.id AS dispositivo_id, d.numero_serie, d.modelo, d.criado_em,
           f.versao_codigo AS versao_firmware, f.valido_de AS desde
    FROM refined.dispositivo d
    LEFT JOIN refined.firmware_versao f ON f.id = d.firmware_versao_atual_id
  )
  INSERT INTO trusted.dim_dispositivo (dispositivo_id, numero_serie, modelo, versao_firmware, valido_de)
  SELECT s.dispositivo_id, s.numero_serie, s.modelo, s.versao_firmware,
         CASE WHEN EXISTS (SELECT 1 FROM trusted.dim_dispositivo x WHERE x.dispositivo_id = s.dispositivo_id)
              THEN coalesce(s.desde, now())
              ELSE '-infinity'::timestamptz
         END
  FROM s
  WHERE NOT EXISTS (
    SELECT 1 FROM trusted.dim_dispositivo t WHERE t.dispositivo_id = s.dispositivo_id AND t.registro_atual);
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  RETURN v_linhas;
END
$$;

-- refined -> trusted: agrega por hora. Idempotente (reprocessar o mesmo período é seguro).
CREATE FUNCTION trusted.carregar_fato_leitura(p_desde timestamptz DEFAULT now() - interval '3 hours')
RETURNS integer
LANGUAGE plpgsql AS
$$
DECLARE v_linhas integer;
BEGIN
  PERFORM trusted.carregar_dim_local();
  PERFORM trusted.carregar_dim_dispositivo();
  PERFORM trusted.carregar_dim_tempo(
    (p_desde AT TIME ZONE 'UTC')::date,
    ((now() AT TIME ZONE 'UTC')::date));

  WITH horas AS (
    SELECT l.dispositivo_id,
           date_trunc('hour', l.medido_em AT TIME ZONE 'UTC') AS hora,
           round(avg(l.pm25_microg_m3), 2) AS pm25_medio,
           max(l.pm25_microg_m3) AS pm25_maximo,
           round(avg(l.co2_ppm), 2) AS co2_medio,
           count(*)::integer AS quantidade_leituras
    FROM refined.leitura_sensor l
    WHERE l.medido_em >= date_trunc('hour', p_desde, 'UTC')
    GROUP BY 1, 2
  ), alertas AS (
    SELECT a.dispositivo_id, date_trunc('hour', a.medido_em_referencia AT TIME ZONE 'UTC') AS hora, count(*)::integer AS quantidade
    FROM refined.alerta a
    WHERE a.medido_em_referencia >= date_trunc('hour', p_desde, 'UTC')
    GROUP BY 1, 2
  )
  INSERT INTO trusted.fato_leitura AS f (
    dispositivo_key, tempo_key, hora_do_dia, local_key,
    pm25_medio, pm25_maximo, co2_medio, quantidade_leituras, quantidade_alertas)
  SELECT dd.dispositivo_key, h.hora::date, extract(hour FROM h.hora)::smallint, dl.local_key,
         h.pm25_medio, h.pm25_maximo, h.co2_medio, h.quantidade_leituras, coalesce(a.quantidade, 0)
  FROM horas h
  JOIN refined.dispositivo d ON d.id = h.dispositivo_id
  JOIN trusted.dim_dispositivo dd ON dd.dispositivo_id = h.dispositivo_id
       AND (h.hora AT TIME ZONE 'UTC') >= dd.valido_de
       AND (dd.valido_ate IS NULL OR (h.hora AT TIME ZONE 'UTC') < dd.valido_ate)
  JOIN trusted.dim_local dl ON dl.local_id = d.local_id
  LEFT JOIN alertas a ON a.dispositivo_id = h.dispositivo_id AND a.hora = h.hora
  ON CONFLICT (dispositivo_key, tempo_key, hora_do_dia) DO UPDATE
    SET pm25_medio = EXCLUDED.pm25_medio, pm25_maximo = EXCLUDED.pm25_maximo, co2_medio = EXCLUDED.co2_medio,
        quantidade_leituras = EXCLUDED.quantidade_leituras, quantidade_alertas = EXCLUDED.quantidade_alertas;
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  RETURN v_linhas;
END
$$;
COMMENT ON FUNCTION trusted.carregar_fato_leitura IS 'refined -> trusted. Carrega dimensões e agrega por hora (UTC). Junta a versão de dispositivo vigente NA HORA do fato (SCD2 correto).';

-- =====================================================================
-- 0007_gatilhos_regras.sql
-- =====================================================================

-- ---------- atualizado_em automático (Cat. A) ----------
CREATE TRIGGER tg_usuario_atualizado_em BEFORE UPDATE ON refined.usuario
  FOR EACH ROW EXECUTE FUNCTION refined.definir_atualizado_em();
CREATE TRIGGER tg_local_atualizado_em BEFORE UPDATE ON refined.local
  FOR EACH ROW EXECUTE FUNCTION refined.definir_atualizado_em();
CREATE TRIGGER tg_dispositivo_atualizado_em BEFORE UPDATE ON refined.dispositivo
  FOR EACH ROW EXECUTE FUNCTION refined.definir_atualizado_em();
CREATE TRIGGER tg_dispositivo_estado_atualizado_em BEFORE UPDATE ON refined.dispositivo_estado
  FOR EACH ROW EXECUTE FUNCTION refined.definir_atualizado_em();
CREATE TRIGGER tg_assinatura_atualizado_em BEFORE UPDATE ON refined.assinatura_plano
  FOR EACH ROW EXECUTE FUNCTION refined.definir_atualizado_em();
CREATE TRIGGER tg_ticket_atualizado_em BEFORE UPDATE ON refined.ticket_suporte
  FOR EACH ROW EXECUTE FUNCTION refined.definir_atualizado_em();

-- ---------- Hierarquia de local: sem ciclos; criador vira membro proprietário ----------
CREATE FUNCTION refined.impedir_ciclo_local() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.local_pai_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE ancestrais (id) AS (
      SELECT NEW.local_pai_id
      UNION ALL
      SELECT l.local_pai_id FROM refined.local l JOIN ancestrais a ON l.id = a.id WHERE l.local_pai_id IS NOT NULL
    )
    SELECT 1 FROM ancestrais WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'local_pai_id cria um ciclo na hierarquia de locais' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_local_sem_ciclo BEFORE INSERT OR UPDATE OF local_pai_id ON refined.local
  FOR EACH ROW EXECUTE FUNCTION refined.impedir_ciclo_local();

CREATE FUNCTION refined.registrar_proprietario_do_local() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
BEGIN
  INSERT INTO refined.local_membro (local_id, usuario_id, nivel_acesso)
  VALUES (NEW.id, NEW.usuario_id, 'proprietario')
  ON CONFLICT (local_id, usuario_id) DO NOTHING;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_local_proprietario_membro AFTER INSERT ON refined.local
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_proprietario_do_local();

-- ---------- Dispositivo: consistência do titular e estado (shadow) inicial ----------
-- usuario_proprietario_id é desnormalizado: precisa ter acesso de proprietário ao local do dispositivo.
CREATE FUNCTION refined.validar_proprietario_dispositivo() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM refined.local l
    WHERE l.id = NEW.local_id
      AND (l.usuario_id = NEW.usuario_proprietario_id
           OR EXISTS (SELECT 1 FROM refined.local_membro m
                      WHERE m.local_id = l.id AND m.usuario_id = NEW.usuario_proprietario_id
                        AND m.nivel_acesso = 'proprietario'))
  ) THEN
    RAISE EXCEPTION 'usuario_proprietario_id não é proprietário do local %', NEW.local_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_dispositivo_proprietario BEFORE INSERT OR UPDATE OF local_id, usuario_proprietario_id ON refined.dispositivo
  FOR EACH ROW EXECUTE FUNCTION refined.validar_proprietario_dispositivo();

CREATE FUNCTION refined.criar_estado_dispositivo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
BEGIN
  INSERT INTO refined.dispositivo_estado (dispositivo_id) VALUES (NEW.id);
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_dispositivo_estado_inicial AFTER INSERT ON refined.dispositivo
  FOR EACH ROW EXECUTE FUNCTION refined.criar_estado_dispositivo();

-- ---------- SCD Tipo 2: fecha a versão vigente ao inserir uma nova ----------
-- TG_ARGV[0] = coluna que agrupa as versões (dispositivo_id | nome_modelo).
CREATE FUNCTION refined.scd2_fechar_versao_anterior() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
BEGIN
  IF NEW.registro_atual THEN
    EXECUTE format(
      'UPDATE %I.%I SET registro_atual = false, valido_ate = $1 WHERE %I::text = $2 AND registro_atual',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0])
    USING NEW.valido_de, to_jsonb(NEW) ->> TG_ARGV[0];
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_firmware_scd2 BEFORE INSERT ON refined.firmware_versao
  FOR EACH ROW EXECUTE FUNCTION refined.scd2_fechar_versao_anterior('dispositivo_id');
CREATE TRIGGER tg_modelo_ia_scd2 BEFORE INSERT ON refined.modelo_ia_versao
  FOR EACH ROW EXECUTE FUNCTION refined.scd2_fechar_versao_anterior('nome_modelo');

CREATE FUNCTION refined.apontar_firmware_atual() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
BEGIN
  IF NEW.registro_atual THEN
    UPDATE refined.dispositivo SET firmware_versao_atual_id = NEW.id WHERE id = NEW.dispositivo_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_firmware_atual AFTER INSERT ON refined.firmware_versao
  FOR EACH ROW EXECUTE FUNCTION refined.apontar_firmware_atual();

-- Rollback de modelo de IA: nova vigência da versão anterior, histórico preservado.
CREATE FUNCTION refined.reverter_modelo_ia(p_nome_modelo text, p_versao_codigo text) RETURNS uuid
LANGUAGE plpgsql AS
$$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM refined.modelo_ia_versao WHERE nome_modelo = p_nome_modelo AND versao_codigo = p_versao_codigo) THEN
    RAISE EXCEPTION 'versão % do modelo % nunca existiu', p_versao_codigo, p_nome_modelo USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO refined.modelo_ia_versao (nome_modelo, versao_codigo) VALUES (p_nome_modelo, p_versao_codigo)
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- ---------- Alerta: histórico do status (Cat. C) ----------
CREATE FUNCTION refined.registrar_mudanca_status() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.status_principal IS DISTINCT FROM OLD.status_principal THEN
    NEW.status_anterior := OLD.status_principal;
    NEW.status_alterado_em := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_alerta_status BEFORE UPDATE OF status_principal ON refined.alerta
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_mudanca_status();

-- ---------- Ticket: violação de SLA ----------
CREATE FUNCTION refined.calcular_sla_violado() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  NEW.sla_violado := coalesce(NEW.resolvido_em, now()) > NEW.sla_limite_em;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_ticket_sla BEFORE INSERT OR UPDATE ON refined.ticket_suporte
  FOR EACH ROW EXECUTE FUNCTION refined.calcular_sla_violado();

-- Para tickets parados, que não recebem escrita: rodar periodicamente (ex.: a cada 5 min).
CREATE FUNCTION refined.marcar_slas_violados() RETURNS integer
LANGUAGE plpgsql AS
$$
DECLARE v_linhas integer;
BEGIN
  UPDATE refined.ticket_suporte SET sla_violado = true
   WHERE resolvido_em IS NULL AND sla_limite_em < now() AND NOT sla_violado;
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  RETURN v_linhas;
END
$$;

-- ---------- RBAC: papel de cliente só para usuário; papel interno só para colaborador ----------
CREATE FUNCTION refined.validar_escopo_papel() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  IF (SELECT escopo FROM refined.papel WHERE id = NEW.papel_id) IS DISTINCT FROM TG_ARGV[0] THEN
    RAISE EXCEPTION 'papel % não tem escopo %', NEW.papel_id, TG_ARGV[0] USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tg_usuario_papel_escopo BEFORE INSERT OR UPDATE ON refined.usuario_papel
  FOR EACH ROW EXECUTE FUNCTION refined.validar_escopo_papel('cliente');
CREATE TRIGGER tg_colaborador_papel_escopo BEFORE INSERT OR UPDATE ON refined.colaborador_papel
  FOR EACH ROW EXECUTE FUNCTION refined.validar_escopo_papel('interno');

-- ---------- Auditoria centralizada ----------
-- TG_ARGV = colunas que identificam o registro (padrão: id). Colunas sensíveis nunca vão ao log.
CREATE FUNCTION refined.registrar_auditoria() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
DECLARE
  v_sensiveis constant text[] := ARRAY['senha_hash', 'token_hash', 'segredo_criptografado', 'chave_api_externa'];
  v_antes jsonb;
  v_depois jsonb;
  v_ref jsonb;
  v_chave text;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_antes := to_jsonb(OLD) - v_sensiveis; END IF;
  IF TG_OP <> 'DELETE' THEN v_depois := to_jsonb(NEW) - v_sensiveis; END IF;

  IF TG_OP = 'UPDATE' AND (v_antes - 'atualizado_em') = (v_depois - 'atualizado_em') THEN
    RETURN NULL;
  END IF;

  v_ref := coalesce(v_depois, v_antes);
  SELECT string_agg(v_ref ->> c, ':' ORDER BY ord) INTO v_chave
  FROM unnest(CASE WHEN TG_NARGS = 0 THEN ARRAY['id'] ELSE TG_ARGV END) WITH ORDINALITY AS t (c, ord);

  INSERT INTO refined.log_auditoria (tabela_afetada, registro_id, operacao, usuario_executor_id, dado_anterior, dado_novo, origem_execucao)
  VALUES (TG_TABLE_NAME, v_chave, lower(TG_OP), refined.usuario_atual(), v_antes, v_depois,
          coalesce(nullif(current_setting('app.origem_execucao', true), ''), 'trigger'));
  RETURN NULL;
END
$$;

CREATE TRIGGER tg_audit_usuario AFTER INSERT OR DELETE ON refined.usuario
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
-- UPDATE de usuário: sem ultimo_login_em / tentativas_login_falhas, que mudam a cada login.
CREATE TRIGGER tg_audit_usuario_upd AFTER UPDATE OF
    nome_completo, email, senha_hash, telefone, telefone_verificado, papel_usuario, status_conta,
    email_verificado, senha_alterada_em, mfa_habilitado, bloqueado_ate, idioma_preferido, fuso_horario,
    consentimento_lgpd_aceito, consentimento_lgpd_data, termos_uso_versao_aceita, termos_uso_aceito_em,
    classificacao_dado, retencao_dado_ate, removido_em
  ON refined.usuario FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();

CREATE TRIGGER tg_audit_dispositivo AFTER INSERT OR DELETE ON refined.dispositivo
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
-- UPDATE de dispositivo: só mudanças de negócio; telemetria (bateria, sinal, ultimo_contato...) fica de fora.
CREATE TRIGGER tg_audit_dispositivo_upd AFTER UPDATE OF
    local_id, usuario_proprietario_id, lote_fabricacao_id, numero_serie, modelo, status_dispositivo,
    intervalo_captacao_segundos, firmware_versao_atual_id, removido_em
  ON refined.dispositivo FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();

CREATE TRIGGER tg_audit_assinatura AFTER INSERT OR UPDATE OR DELETE ON refined.assinatura_plano
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
CREATE TRIGGER tg_audit_integracao AFTER INSERT OR UPDATE OR DELETE ON refined.integracao_externa
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
CREATE TRIGGER tg_audit_colaborador AFTER INSERT OR UPDATE OR DELETE ON refined.colaborador
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
CREATE TRIGGER tg_audit_feature_flag AFTER INSERT OR UPDATE OR DELETE ON refined.feature_flag
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
CREATE TRIGGER tg_audit_modelo_ia AFTER INSERT OR UPDATE OR DELETE ON refined.modelo_ia_versao
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
CREATE TRIGGER tg_audit_solicitacao_titular AFTER INSERT OR UPDATE OR DELETE ON refined.solicitacao_titular_dados
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria();
CREATE TRIGGER tg_audit_usuario_papel AFTER INSERT OR DELETE ON refined.usuario_papel
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria('usuario_id', 'papel_id');
CREATE TRIGGER tg_audit_colaborador_papel AFTER INSERT OR DELETE ON refined.colaborador_papel
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria('colaborador_id', 'papel_id');
CREATE TRIGGER tg_audit_papel_permissao AFTER INSERT OR DELETE ON refined.papel_permissao
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria('papel_id', 'permissao_id');
CREATE TRIGGER tg_audit_usuario_organizacao AFTER INSERT OR UPDATE OR DELETE ON refined.usuario_organizacao
  FOR EACH ROW EXECUTE FUNCTION refined.registrar_auditoria('usuario_id', 'organizacao_id');

-- A trilha de auditoria é somente-inserção.
CREATE FUNCTION refined.proibir_alteracao_auditoria() RETURNS trigger
LANGUAGE plpgsql AS
$$
BEGIN
  RAISE EXCEPTION 'log_auditoria é somente-inserção (% proibido)', TG_OP USING ERRCODE = 'restrict_violation';
END
$$;
CREATE TRIGGER tg_auditoria_imutavel BEFORE UPDATE OR DELETE ON refined.log_auditoria
  FOR EACH ROW EXECUTE FUNCTION refined.proibir_alteracao_auditoria();
CREATE TRIGGER tg_auditoria_sem_truncate BEFORE TRUNCATE ON refined.log_auditoria
  FOR EACH STATEMENT EXECUTE FUNCTION refined.proibir_alteracao_auditoria();

-- =====================================================================
-- 0008_seguranca_rls_privilegios.sql
-- =====================================================================

-- =====================================================================
-- Funções de acesso (SECURITY DEFINER evita recursão de RLS).
-- O usuário da sessão vem de refined.usuario_atual() (SET LOCAL app.usuario_id).
-- =====================================================================
CREATE FUNCTION refined.acesso_local(p_local_id uuid, p_gerenciar boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
  SELECT EXISTS (
    SELECT 1 FROM refined.local l
    WHERE l.id = p_local_id AND (
      l.usuario_id = refined.usuario_atual()
      OR EXISTS (SELECT 1 FROM refined.local_membro m
                 WHERE m.local_id = l.id AND m.usuario_id = refined.usuario_atual()
                   AND (NOT p_gerenciar OR m.nivel_acesso = 'proprietario'))
      OR (l.organizacao_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM refined.usuario_organizacao uo
            WHERE uo.organizacao_id = l.organizacao_id AND uo.usuario_id = refined.usuario_atual()
              AND uo.papel_na_organizacao IN ('gestor', 'administrador')))
    ))
$$;
COMMENT ON FUNCTION refined.acesso_local IS 'O usuário da sessão acessa o local? p_gerenciar = true exige proprietário/gestor (editar); false basta ser membro (ver).';

CREATE FUNCTION refined.acesso_dispositivo(p_dispositivo_id uuid, p_gerenciar boolean DEFAULT false) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
  SELECT EXISTS (
    SELECT 1 FROM refined.dispositivo d
    WHERE d.id = p_dispositivo_id
      AND (d.usuario_proprietario_id = refined.usuario_atual() OR refined.acesso_local(d.local_id, p_gerenciar)))
$$;

CREATE FUNCTION refined.gestor_da_organizacao(p_organizacao_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
  SELECT EXISTS (
    SELECT 1 FROM refined.usuario_organizacao uo
    WHERE uo.organizacao_id = p_organizacao_id AND uo.usuario_id = refined.usuario_atual()
      AND uo.papel_na_organizacao IN ('gestor', 'administrador'))
$$;

CREATE FUNCTION refined.dispositivos_acessiveis() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, refined AS
$$
  SELECT d.id FROM refined.dispositivo d
  WHERE d.removido_em IS NULL
    AND (d.usuario_proprietario_id = refined.usuario_atual() OR refined.acesso_local(d.local_id, false))
$$;

-- leitura_sensor não recebe RLS (hypertable comprimida): a API lê por esta view, que filtra
-- pelos dispositivos acessíveis. Quem consulta a view não tem SELECT na tabela base.
CREATE VIEW refined.v_leitura_sensor_usuario AS
SELECT l.*
FROM refined.leitura_sensor l
WHERE l.dispositivo_id IN (SELECT refined.dispositivos_acessiveis());
COMMENT ON VIEW refined.v_leitura_sensor_usuario IS 'Leituras dos dispositivos a que a sessão tem acesso. Ao adicionar colunas em leitura_sensor, recriar a view.';

-- =====================================================================
-- Row Level Security: restringe SOMENTE clean_air_app. Os papéis de serviço
-- passam pela política servico_total e são limitados por GRANT.
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'usuario', 'sessao_autenticacao', 'login_provedor_externo', 'usuario_papel',
    'local', 'local_membro', 'dispositivo', 'dispositivo_estado', 'evento_sonoro_detectado',
    'firmware_versao', 'garantia_dispositivo', 'alerta', 'recomendacao', 'notificacao_enviada',
    'preferencia_notificacao', 'assinatura_plano', 'ticket_suporte', 'integracao_externa',
    'solicitacao_titular_dados', 'organizacao', 'usuario_organizacao']
  LOOP
    EXECUTE format('ALTER TABLE refined.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY servico_total ON refined.%I TO clean_air_auth, clean_air_ingestao USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;

-- Políticas do usuário final. Em SELECT usamos primeiro a coluna direta: o INSERT ... RETURNING
-- precisa enxergar a própria linha nova, que uma função STABLE ainda não veria.
CREATE POLICY app_usuario_leitura ON refined.usuario FOR SELECT TO clean_air_app
  USING (id = refined.usuario_atual());
CREATE POLICY app_usuario_edicao ON refined.usuario FOR UPDATE TO clean_air_app
  USING (id = refined.usuario_atual()) WITH CHECK (id = refined.usuario_atual());

CREATE POLICY app_sessao_leitura ON refined.sessao_autenticacao FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());
CREATE POLICY app_sessao_revogar ON refined.sessao_autenticacao FOR UPDATE TO clean_air_app
  USING (usuario_id = refined.usuario_atual()) WITH CHECK (usuario_id = refined.usuario_atual());
CREATE POLICY app_login_externo_leitura ON refined.login_provedor_externo FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());
CREATE POLICY app_usuario_papel_leitura ON refined.usuario_papel FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());

CREATE POLICY app_local_leitura ON refined.local FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual() OR refined.acesso_local(id, false));
CREATE POLICY app_local_criacao ON refined.local FOR INSERT TO clean_air_app
  WITH CHECK (usuario_id = refined.usuario_atual()
              AND (organizacao_id IS NULL OR refined.gestor_da_organizacao(organizacao_id)));
CREATE POLICY app_local_edicao ON refined.local FOR UPDATE TO clean_air_app
  USING (usuario_id = refined.usuario_atual() OR refined.acesso_local(id, true))
  WITH CHECK (usuario_id = refined.usuario_atual() OR refined.acesso_local(id, true));

CREATE POLICY app_local_membro_leitura ON refined.local_membro FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual() OR refined.acesso_local(local_id, true));
CREATE POLICY app_local_membro_escrita ON refined.local_membro FOR ALL TO clean_air_app
  USING (refined.acesso_local(local_id, true)) WITH CHECK (refined.acesso_local(local_id, true));

CREATE POLICY app_dispositivo_leitura ON refined.dispositivo FOR SELECT TO clean_air_app
  USING (usuario_proprietario_id = refined.usuario_atual() OR refined.acesso_local(local_id, false));
CREATE POLICY app_dispositivo_criacao ON refined.dispositivo FOR INSERT TO clean_air_app
  WITH CHECK (usuario_proprietario_id = refined.usuario_atual() AND refined.acesso_local(local_id, true));
CREATE POLICY app_dispositivo_edicao ON refined.dispositivo FOR UPDATE TO clean_air_app
  USING (usuario_proprietario_id = refined.usuario_atual() OR refined.acesso_local(local_id, true))
  WITH CHECK (usuario_proprietario_id = refined.usuario_atual() OR refined.acesso_local(local_id, true));

CREATE POLICY app_estado_leitura ON refined.dispositivo_estado FOR SELECT TO clean_air_app
  USING (refined.acesso_dispositivo(dispositivo_id, false));
CREATE POLICY app_estado_edicao ON refined.dispositivo_estado FOR UPDATE TO clean_air_app
  USING (refined.acesso_dispositivo(dispositivo_id, true)) WITH CHECK (refined.acesso_dispositivo(dispositivo_id, true));
CREATE POLICY app_evento_sonoro_leitura ON refined.evento_sonoro_detectado FOR SELECT TO clean_air_app
  USING (refined.acesso_dispositivo(dispositivo_id, false));
CREATE POLICY app_firmware_leitura ON refined.firmware_versao FOR SELECT TO clean_air_app
  USING (refined.acesso_dispositivo(dispositivo_id, false));
CREATE POLICY app_garantia_leitura ON refined.garantia_dispositivo FOR SELECT TO clean_air_app
  USING (refined.acesso_dispositivo(dispositivo_id, false));

CREATE POLICY app_alerta_leitura ON refined.alerta FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());
CREATE POLICY app_alerta_edicao ON refined.alerta FOR UPDATE TO clean_air_app
  USING (usuario_id = refined.usuario_atual()) WITH CHECK (usuario_id = refined.usuario_atual());
-- recomendacao herda a visibilidade do alerta: a subconsulta já passa pela RLS de alerta.
CREATE POLICY app_recomendacao_leitura ON refined.recomendacao FOR SELECT TO clean_air_app
  USING (EXISTS (SELECT 1 FROM refined.alerta a WHERE a.id = alerta_id));
CREATE POLICY app_recomendacao_edicao ON refined.recomendacao FOR UPDATE TO clean_air_app
  USING (EXISTS (SELECT 1 FROM refined.alerta a WHERE a.id = alerta_id))
  WITH CHECK (EXISTS (SELECT 1 FROM refined.alerta a WHERE a.id = alerta_id));
CREATE POLICY app_notificacao_leitura ON refined.notificacao_enviada FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());
CREATE POLICY app_notificacao_edicao ON refined.notificacao_enviada FOR UPDATE TO clean_air_app
  USING (usuario_id = refined.usuario_atual()) WITH CHECK (usuario_id = refined.usuario_atual());
CREATE POLICY app_preferencia_total ON refined.preferencia_notificacao FOR ALL TO clean_air_app
  USING (usuario_id = refined.usuario_atual()) WITH CHECK (usuario_id = refined.usuario_atual());

CREATE POLICY app_assinatura_leitura ON refined.assinatura_plano FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());
CREATE POLICY app_ticket_leitura ON refined.ticket_suporte FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());
CREATE POLICY app_ticket_criacao ON refined.ticket_suporte FOR INSERT TO clean_air_app
  WITH CHECK (usuario_id = refined.usuario_atual()
              AND (dispositivo_id IS NULL OR refined.acesso_dispositivo(dispositivo_id, false)));
CREATE POLICY app_ticket_avaliacao ON refined.ticket_suporte FOR UPDATE TO clean_air_app
  USING (usuario_id = refined.usuario_atual()) WITH CHECK (usuario_id = refined.usuario_atual());
CREATE POLICY app_integracao_total ON refined.integracao_externa FOR ALL TO clean_air_app
  USING (usuario_id = refined.usuario_atual()) WITH CHECK (usuario_id = refined.usuario_atual());
CREATE POLICY app_solicitacao_leitura ON refined.solicitacao_titular_dados FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual());
CREATE POLICY app_solicitacao_criacao ON refined.solicitacao_titular_dados FOR INSERT TO clean_air_app
  WITH CHECK (usuario_id = refined.usuario_atual());

CREATE POLICY app_organizacao_leitura ON refined.organizacao FOR SELECT TO clean_air_app
  USING (EXISTS (SELECT 1 FROM refined.usuario_organizacao uo
                 WHERE uo.organizacao_id = organizacao.id AND uo.usuario_id = refined.usuario_atual()));
CREATE POLICY app_usuario_org_leitura ON refined.usuario_organizacao FOR SELECT TO clean_air_app
  USING (usuario_id = refined.usuario_atual() OR refined.gestor_da_organizacao(organizacao_id));
CREATE POLICY app_usuario_org_escrita ON refined.usuario_organizacao FOR ALL TO clean_air_app
  USING (refined.gestor_da_organizacao(organizacao_id)) WITH CHECK (refined.gestor_da_organizacao(organizacao_id));

-- =====================================================================
-- Privilégios por papel (menor privilégio). Colunas sensíveis ficam de fora do SELECT.
-- =====================================================================
GRANT USAGE ON SCHEMA refined TO clean_air_auth, clean_air_app, clean_air_ingestao;
GRANT USAGE ON SCHEMA raw TO clean_air_ingestao;
GRANT USAGE ON SCHEMA trusted TO clean_air_analitico;

-- --- clean_air_auth: signup, login, recuperação de senha, sessões ---
GRANT SELECT, INSERT, UPDATE ON refined.usuario TO clean_air_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON refined.token_verificacao, refined.sessao_autenticacao, refined.mfa_configuracao TO clean_air_auth;
GRANT SELECT, INSERT, DELETE ON refined.login_provedor_externo, refined.usuario_papel TO clean_air_auth;
GRANT SELECT, INSERT ON refined.assinatura_plano, refined.preferencia_notificacao TO clean_air_auth;
GRANT SELECT ON refined.papel, refined.permissao, refined.papel_permissao TO clean_air_auth;

-- --- clean_air_app: usuário final ---
GRANT SELECT (id, nome_completo, email, telefone, telefone_verificado, papel_usuario, status_conta, email_verificado,
              ultimo_login_em, senha_alterada_em, mfa_habilitado, idioma_preferido, fuso_horario,
              consentimento_lgpd_aceito, consentimento_lgpd_data, termos_uso_versao_aceita, termos_uso_aceito_em,
              criado_em, atualizado_em)
  ON refined.usuario TO clean_air_app;
GRANT UPDATE (nome_completo, telefone, idioma_preferido, fuso_horario, consentimento_lgpd_aceito,
              consentimento_lgpd_data, termos_uso_versao_aceita, termos_uso_aceito_em)
  ON refined.usuario TO clean_air_app;
GRANT SELECT (id, usuario_id, ip_origem, user_agent, criado_em, expira_em, revogado_em)
  ON refined.sessao_autenticacao TO clean_air_app;
GRANT UPDATE (revogado_em) ON refined.sessao_autenticacao TO clean_air_app;
GRANT SELECT (id, usuario_id, provedor, criado_em) ON refined.login_provedor_externo TO clean_air_app;
GRANT SELECT ON refined.usuario_papel, refined.papel, refined.permissao, refined.papel_permissao TO clean_air_app;

GRANT SELECT, INSERT ON refined.local TO clean_air_app;
GRANT UPDATE (local_pai_id, nome, tipo_local, latitude, longitude, fuso_horario, ativo, removido_em) ON refined.local TO clean_air_app;
GRANT SELECT, INSERT, UPDATE (nivel_acesso), DELETE ON refined.local_membro TO clean_air_app;
GRANT SELECT, INSERT ON refined.dispositivo TO clean_air_app;
GRANT UPDATE (local_id, usuario_proprietario_id, intervalo_captacao_segundos, data_ativacao, status_dispositivo, removido_em)
  ON refined.dispositivo TO clean_air_app;
GRANT SELECT ON refined.dispositivo_estado, refined.evento_sonoro_detectado, refined.firmware_versao,
                refined.garantia_dispositivo, refined.feature_flag, refined.modelo_ia_versao,
                refined.assinatura_plano, refined.organizacao TO clean_air_app;
GRANT UPDATE (estado_desejado) ON refined.dispositivo_estado TO clean_air_app;
GRANT SELECT ON refined.v_leitura_sensor_usuario TO clean_air_app;

GRANT SELECT ON refined.alerta, refined.recomendacao, refined.notificacao_enviada TO clean_air_app;
GRANT UPDATE (status_principal) ON refined.alerta TO clean_air_app;
GRANT UPDATE (aceita_pelo_usuario) ON refined.recomendacao TO clean_air_app;
GRANT UPDATE (status_principal, lido_em) ON refined.notificacao_enviada TO clean_air_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refined.preferencia_notificacao TO clean_air_app;

GRANT SELECT, INSERT ON refined.ticket_suporte, refined.solicitacao_titular_dados TO clean_air_app;
GRANT UPDATE (nivel_satisfacao) ON refined.ticket_suporte TO clean_air_app;
GRANT SELECT (id, usuario_id, servico_terceiro, escopo_permissao, status_principal, ultima_sincronizacao_em, criado_em)
  ON refined.integracao_externa TO clean_air_app;
GRANT INSERT, DELETE ON refined.integracao_externa TO clean_air_app;
GRANT UPDATE (escopo_permissao, status_principal) ON refined.integracao_externa TO clean_air_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refined.usuario_organizacao TO clean_air_app;

-- --- clean_air_ingestao: pipeline de ingestão e geração de alertas ---
GRANT SELECT, INSERT, UPDATE, DELETE ON raw.lote_ingestao, raw.leitura_bruta TO clean_air_ingestao;
GRANT SELECT, INSERT ON refined.leitura_sensor TO clean_air_ingestao;
GRANT SELECT ON refined.dispositivo, refined.local, refined.local_membro, refined.organizacao,
                refined.usuario_organizacao, refined.preferencia_notificacao, refined.modelo_ia_versao,
                refined.feature_flag, refined.dispositivo_estado TO clean_air_ingestao;
GRANT UPDATE (status_conexao, ultimo_contato_em, nivel_bateria_percentual, intensidade_sinal_dbm,
              contagem_erros_consecutivos, ultima_sincronizacao_em)
  ON refined.dispositivo TO clean_air_ingestao;
GRANT UPDATE (estado_reportado) ON refined.dispositivo_estado TO clean_air_ingestao;
GRANT SELECT, INSERT ON refined.firmware_versao, refined.alerta, refined.recomendacao, refined.evento_sonoro_detectado TO clean_air_ingestao;
GRANT SELECT, INSERT, UPDATE ON refined.notificacao_enviada TO clean_air_ingestao;

-- --- clean_air_analitico: somente leitura, somente trusted ---
GRANT SELECT ON ALL TABLES IN SCHEMA trusted TO clean_air_analitico;

-- Funções de carga e de manutenção: só quem opera (dono/jobs) ou o pipeline de ingestão.
REVOKE ALL ON FUNCTION refined.carregar_leituras_do_raw(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refined.carregar_leituras_do_raw(integer) TO clean_air_ingestao;
REVOKE ALL ON FUNCTION trusted.carregar_dim_tempo(date, date), trusted.carregar_dim_local(),
  trusted.carregar_dim_dispositivo(), trusted.carregar_fato_leitura(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION refined.reverter_modelo_ia(text, text), refined.marcar_slas_violados() FROM PUBLIC;

-- =====================================================================
-- 0009_timescaledb_hypertable.sql
-- =====================================================================

-- Expurgo da camada raw: retenção curta, só o necessário para reprocessar uma carga que falhou.
-- Função comum (não depende do TimescaleDB). Agendar diariamente (pg_cron ou job da aplicação).
CREATE FUNCTION raw.expurgar_processados(p_dias integer DEFAULT 7) RETURNS integer
LANGUAGE plpgsql AS
$$
DECLARE v_linhas integer;
BEGIN
  DELETE FROM raw.leitura_bruta WHERE processado_em IS NOT NULL AND processado_em < now() - make_interval(days => p_dias);
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  DELETE FROM raw.lote_ingestao l
   WHERE l.recebido_em < now() - make_interval(days => p_dias)
     AND NOT EXISTS (SELECT 1 FROM raw.leitura_bruta b WHERE b.lote_ingestao_id = l.id);
  RETURN v_linhas;
END
$$;
REVOKE ALL ON FUNCTION raw.expurgar_processados(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION raw.expurgar_processados(integer) TO clean_air_ingestao;

-- TimescaleDB: hypertable + compressão + retenção. Sem a extensão instalada (ex.: PostgreSQL puro
-- em desenvolvimento) a migration apenas avisa; o restante do esquema funciona igual.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb') THEN
    RAISE NOTICE 'TimescaleDB indisponível: refined.leitura_sensor permanece como tabela comum.';
    RETURN;
  END IF;

  CREATE EXTENSION IF NOT EXISTS timescaledb;

  -- Chunks de 7 dias: com o padrão de 60 s (~1,4 mil linhas/dispositivo/dia) o índice de cada chunk
  -- cabe em memória mesmo com milhares de dispositivos; no pior caso (1 s) reavaliar o intervalo.
  PERFORM create_hypertable('refined.leitura_sensor', by_range('medido_em', interval '7 days'), if_not_exists => true);

  ALTER TABLE refined.leitura_sensor SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'dispositivo_id',
    timescaledb.compress_orderby = 'medido_em DESC');

  PERFORM add_compression_policy('refined.leitura_sensor', interval '7 days', if_not_exists => true);
  -- RF de software exige histórico >= 12 meses; 24 meses dão folga para comparativos anuais.
  PERFORM add_retention_policy('refined.leitura_sensor', interval '24 months', if_not_exists => true);
END $$;
