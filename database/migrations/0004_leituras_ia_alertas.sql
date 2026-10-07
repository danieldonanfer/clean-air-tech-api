-- Up Migration

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

-- Down Migration

DROP TABLE IF EXISTS refined.preferencia_notificacao;
DROP TABLE IF EXISTS refined.notificacao_enviada;
DROP TABLE IF EXISTS refined.recomendacao;
DROP TABLE IF EXISTS refined.alerta;
DROP TABLE IF EXISTS refined.evento_sonoro_detectado;
DROP TABLE IF EXISTS refined.leitura_sensor;
DROP TABLE IF EXISTS refined.modelo_ia_versao;
