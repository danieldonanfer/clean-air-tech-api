-- Up Migration

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

-- Down Migration

DROP TRIGGER IF EXISTS tg_auditoria_sem_truncate ON refined.log_auditoria;
DROP TRIGGER IF EXISTS tg_auditoria_imutavel ON refined.log_auditoria;
DROP TRIGGER IF EXISTS tg_audit_usuario_organizacao ON refined.usuario_organizacao;
DROP TRIGGER IF EXISTS tg_audit_papel_permissao ON refined.papel_permissao;
DROP TRIGGER IF EXISTS tg_audit_colaborador_papel ON refined.colaborador_papel;
DROP TRIGGER IF EXISTS tg_audit_usuario_papel ON refined.usuario_papel;
DROP TRIGGER IF EXISTS tg_audit_solicitacao_titular ON refined.solicitacao_titular_dados;
DROP TRIGGER IF EXISTS tg_audit_modelo_ia ON refined.modelo_ia_versao;
DROP TRIGGER IF EXISTS tg_audit_feature_flag ON refined.feature_flag;
DROP TRIGGER IF EXISTS tg_audit_colaborador ON refined.colaborador;
DROP TRIGGER IF EXISTS tg_audit_integracao ON refined.integracao_externa;
DROP TRIGGER IF EXISTS tg_audit_assinatura ON refined.assinatura_plano;
DROP TRIGGER IF EXISTS tg_audit_dispositivo_upd ON refined.dispositivo;
DROP TRIGGER IF EXISTS tg_audit_dispositivo ON refined.dispositivo;
DROP TRIGGER IF EXISTS tg_audit_usuario_upd ON refined.usuario;
DROP TRIGGER IF EXISTS tg_audit_usuario ON refined.usuario;
DROP TRIGGER IF EXISTS tg_colaborador_papel_escopo ON refined.colaborador_papel;
DROP TRIGGER IF EXISTS tg_usuario_papel_escopo ON refined.usuario_papel;
DROP TRIGGER IF EXISTS tg_ticket_sla ON refined.ticket_suporte;
DROP TRIGGER IF EXISTS tg_alerta_status ON refined.alerta;
DROP TRIGGER IF EXISTS tg_firmware_atual ON refined.firmware_versao;
DROP TRIGGER IF EXISTS tg_modelo_ia_scd2 ON refined.modelo_ia_versao;
DROP TRIGGER IF EXISTS tg_firmware_scd2 ON refined.firmware_versao;
DROP TRIGGER IF EXISTS tg_dispositivo_estado_inicial ON refined.dispositivo;
DROP TRIGGER IF EXISTS tg_dispositivo_proprietario ON refined.dispositivo;
DROP TRIGGER IF EXISTS tg_local_proprietario_membro ON refined.local;
DROP TRIGGER IF EXISTS tg_local_sem_ciclo ON refined.local;
DROP TRIGGER IF EXISTS tg_ticket_atualizado_em ON refined.ticket_suporte;
DROP TRIGGER IF EXISTS tg_assinatura_atualizado_em ON refined.assinatura_plano;
DROP TRIGGER IF EXISTS tg_dispositivo_estado_atualizado_em ON refined.dispositivo_estado;
DROP TRIGGER IF EXISTS tg_dispositivo_atualizado_em ON refined.dispositivo;
DROP TRIGGER IF EXISTS tg_local_atualizado_em ON refined.local;
DROP TRIGGER IF EXISTS tg_usuario_atualizado_em ON refined.usuario;
DROP FUNCTION IF EXISTS refined.proibir_alteracao_auditoria();
DROP FUNCTION IF EXISTS refined.registrar_auditoria();
DROP FUNCTION IF EXISTS refined.validar_escopo_papel();
DROP FUNCTION IF EXISTS refined.marcar_slas_violados();
DROP FUNCTION IF EXISTS refined.calcular_sla_violado();
DROP FUNCTION IF EXISTS refined.registrar_mudanca_status();
DROP FUNCTION IF EXISTS refined.reverter_modelo_ia(text, text);
DROP FUNCTION IF EXISTS refined.apontar_firmware_atual();
DROP FUNCTION IF EXISTS refined.scd2_fechar_versao_anterior();
DROP FUNCTION IF EXISTS refined.criar_estado_dispositivo();
DROP FUNCTION IF EXISTS refined.validar_proprietario_dispositivo();
DROP FUNCTION IF EXISTS refined.registrar_proprietario_do_local();
DROP FUNCTION IF EXISTS refined.impedir_ciclo_local();
