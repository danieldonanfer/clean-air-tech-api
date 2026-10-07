-- Up Migration

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

-- Down Migration

DROP FUNCTION IF EXISTS trusted.carregar_fato_leitura(timestamptz);
DROP FUNCTION IF EXISTS trusted.carregar_dim_dispositivo();
DROP FUNCTION IF EXISTS trusted.carregar_dim_local();
DROP TABLE IF EXISTS trusted.fato_leitura;
DROP TABLE IF EXISTS trusted.dim_dispositivo;
DROP TABLE IF EXISTS trusted.dim_local;
DROP FUNCTION IF EXISTS trusted.carregar_dim_tempo(date, date);
DROP TABLE IF EXISTS trusted.dim_tempo;
DROP FUNCTION IF EXISTS refined.carregar_leituras_do_raw(integer);
DROP TABLE IF EXISTS raw.leitura_bruta;
DROP TABLE IF EXISTS raw.lote_ingestao;
