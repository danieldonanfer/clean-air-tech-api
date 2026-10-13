-- Up Migration

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

-- Down Migration

DROP TABLE IF EXISTS refined.solicitacao_titular_dados;
DROP TABLE IF EXISTS refined.log_auditoria;
DROP TABLE IF EXISTS refined.integracao_externa;
DROP TABLE IF EXISTS refined.ticket_suporte;
DROP VIEW IF EXISTS refined.v_saude_conta_atual;
DROP TABLE IF EXISTS refined.saude_conta;
DROP TABLE IF EXISTS refined.assinatura_plano;
