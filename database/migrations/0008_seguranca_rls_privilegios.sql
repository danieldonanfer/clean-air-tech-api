-- Up Migration

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

-- Down Migration

DROP VIEW IF EXISTS refined.v_leitura_sensor_usuario;
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
    EXECUTE format('ALTER TABLE refined.%I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
-- As políticas caem com DROP OWNED; os privilégios, com REVOKE ALL (0001 remove os papéis).
REVOKE ALL ON ALL TABLES IN SCHEMA refined FROM clean_air_auth, clean_air_app, clean_air_ingestao;
REVOKE ALL ON ALL TABLES IN SCHEMA raw FROM clean_air_ingestao;
REVOKE ALL ON ALL TABLES IN SCHEMA trusted FROM clean_air_analitico;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT schemaname, tablename, policyname FROM pg_policies WHERE schemaname = 'refined' LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS refined.dispositivos_acessiveis();
DROP FUNCTION IF EXISTS refined.gestor_da_organizacao(uuid);
DROP FUNCTION IF EXISTS refined.acesso_dispositivo(uuid, boolean);
DROP FUNCTION IF EXISTS refined.acesso_local(uuid, boolean);
