-- Up Migration

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

-- Down Migration

DROP TABLE IF EXISTS refined.garantia_dispositivo;
DROP TABLE IF EXISTS refined.certificacao_dispositivo;
DROP TABLE IF EXISTS refined.feature_flag;
ALTER TABLE IF EXISTS refined.dispositivo DROP CONSTRAINT IF EXISTS fk_dispositivo_firmware_atual;
DROP TABLE IF EXISTS refined.firmware_versao;
DROP TABLE IF EXISTS refined.dispositivo_grupo;
DROP TABLE IF EXISTS refined.grupo_dispositivo;
DROP TABLE IF EXISTS refined.dispositivo_estado;
DROP TABLE IF EXISTS refined.dispositivo;
DROP TABLE IF EXISTS refined.lote_fabricacao;
DROP TABLE IF EXISTS refined.local_membro;
DROP TABLE IF EXISTS refined.local;
DROP TABLE IF EXISTS refined.usuario_organizacao;
DROP TABLE IF EXISTS refined.organizacao;
