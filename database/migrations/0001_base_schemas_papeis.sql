-- Up Migration

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

-- Down Migration

DROP SCHEMA IF EXISTS trusted CASCADE;
DROP SCHEMA IF EXISTS refined CASCADE;
DROP SCHEMA IF EXISTS raw CASCADE;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['clean_air_auth', 'clean_air_app', 'clean_air_ingestao', 'clean_air_analitico']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('DROP OWNED BY %I', r);
      EXECUTE format('DROP ROLE %I', r);
    END IF;
  END LOOP;
END $$;
