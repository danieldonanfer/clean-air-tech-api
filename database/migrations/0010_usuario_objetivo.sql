-- Up Migration

-- Objetivo escolhido no cadastro. As chaves são as da tela de cadastro do aplicativo.
ALTER TABLE refined.usuario ADD COLUMN objetivo_uso text NOT NULL DEFAULT 'outro';
ALTER TABLE refined.usuario ADD CONSTRAINT ck_usuario_objetivo_uso
  CHECK (objetivo_uso IN ('ar', 'alergia', 'conforto', 'outro'));
COMMENT ON COLUMN refined.usuario.objetivo_uso IS 'Objetivo de uso escolhido no cadastro: ar (monitoramento do ar e poluentes), alergia (controle de alergias e asma), conforto (conforto e automação) ou outro.';

-- clean_air_auth já tem SELECT/INSERT/UPDATE na tabela inteira (0008) e cobre a coluna nova.
-- clean_air_app lê por colunas, então a nova precisa de concessão própria (somente leitura).
GRANT SELECT (objetivo_uso) ON refined.usuario TO clean_air_app;

-- Down Migration

-- Remover a coluna leva junto a constraint e o GRANT de coluna.
ALTER TABLE refined.usuario DROP COLUMN IF EXISTS objetivo_uso;
