-- Up Migration

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

-- Down Migration

DO $$
DECLARE v_hypertable boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    EXECUTE $q$SELECT EXISTS (SELECT 1 FROM timescaledb_information.hypertables
                              WHERE hypertable_schema = 'refined' AND hypertable_name = 'leitura_sensor')$q$
      INTO v_hypertable;
    IF v_hypertable THEN
      PERFORM remove_retention_policy('refined.leitura_sensor', if_exists => true);
      PERFORM remove_compression_policy('refined.leitura_sensor', if_exists => true);
    END IF;
  END IF;
END $$;
DROP FUNCTION IF EXISTS raw.expurgar_processados(integer);
