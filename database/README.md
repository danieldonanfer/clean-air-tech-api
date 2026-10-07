# Banco de dados — Clean Air Tech

PostgreSQL 17 + TimescaleDB, organizado em três camadas (`raw` → `refined` → `trusted`), com 43 tabelas, RBAC, multi-organização, gestão de frota de dispositivos, auditoria imutável e suporte à LGPD.

| O que você quer | Onde |
|---|---|
| Ver o modelo (diagramas, dicionário de dados) | [`docs/Esquema_Banco_Clean_Air_Tech.pdf`](docs/Esquema_Banco_Clean_Air_Tech.pdf) |
| Ler o esquema inteiro em SQL | [`docs/schema.sql`](docs/schema.sql) (gerado das migrations) |
| Diagramas individuais | [`docs/diagramas/`](docs/diagramas) (`.svg`, `.png` e o fonte Mermaid `.mmd`) |
| Migrations | [`migrations/`](migrations) |
| Testes | [`tests/`](tests) |

## Estrutura

```
database/
  migrations/   SQL versionado, ordem numérica, cada arquivo com Up e Down
  tests/        testes do esquema (node:test + pg) em PostgreSQL real
  scripts/      validar, gerar-schema, gerar-diagramas, ambiente
  docs/         schema.sql, diagramas e PDF (gerados; versionados para consulta)
```

| Migration | Conteúdo |
|---|---|
| `0001` | schemas das camadas, papéis de banco, funções utilitárias |
| `0002` | identidade, autenticação (e-mail, telefone, login social, MFA, sessões) e RBAC |
| `0003` | organizações, ambientes (hierarquia, compartilhamento) e gestão de frota |
| `0004` | leituras dos sensores, IA, alertas, recomendações e notificações |
| `0005` | planos, saúde da conta, suporte com SLA, integrações, auditoria e LGPD |
| `0006` | camadas raw e trusted e as funções de carga (raw → refined → trusted) |
| `0007` | gatilhos: integridade, SCD Tipo 2, SLA, auditoria |
| `0008` | funções de acesso, Row Level Security e privilégios por papel |
| `0009` | TimescaleDB: hypertable, compressão e retenção (no-op sem a extensão) |

## Rodando

Precisa de Node 22+. **Não precisa de Docker**: os testes sobem um PostgreSQL real e descartável (pacote `embedded-postgres`).

```bash
npm install
npm run db:validar      # up -> down -> up das migrations + todos os testes
```

Para aplicar as migrations em um banco seu (o usuário precisa poder criar papéis e schemas):

```bash
export DATABASE_URL=postgres://usuario:senha@localhost:5432/clean_air
npm run db:migrate      # aplica as pendentes
npm run db:rollback     # desfaz a última
```

Com TimescaleDB de verdade (por exemplo a imagem `timescale/timescaledb:latest-pg17`), a migration `0009` cria a hypertable; defina `TIMESCALE=1` ao rodar `db:validar` para incluir os testes dela. O CI já faz isso.

> Sem o TimescaleDB instalado, `refined.leitura_sensor` fica como tabela comum e tudo o mais funciona igual. Isso é só para desenvolvimento: em produção use TimescaleDB.

## Como a API deve usar o banco

Quatro papéis `NOLOGIN` são criados pela migration `0001`; quem faz o deploy concede `LOGIN` e senha fora do repositório.

| Papel | Usado por | Pode |
|---|---|---|
| `clean_air_auth` | cadastro, login, recuperação de senha, sessões | criar contas, tokens e sessões; **não** vê dispositivos |
| `clean_air_app` | requisições de um usuário autenticado | só o que a RLS permite ao usuário da sessão |
| `clean_air_ingestao` | pipeline que recebe as leituras | gravar raw e leituras, gerar alertas, atualizar telemetria |
| `clean_air_analitico` | BI e relatórios | somente leitura na camada `trusted` |

Cada requisição do usuário final precisa informar quem é, **dentro da transação**:

```sql
BEGIN;
SET LOCAL ROLE clean_air_app;
SELECT set_config('app.usuario_id', '<uuid-do-usuario>', true);
-- ... consultas ...
COMMIT;
```

Sem `app.usuario_id`, o papel `clean_air_app` não enxerga nada (falha fechada). Leituras dos sensores são lidas pela view `refined.v_leitura_sensor_usuario`, nunca pela tabela base.

Funções para jobs agendados: `refined.carregar_leituras_do_raw()`, `trusted.carregar_fato_leitura()`, `refined.marcar_slas_violados()`, `raw.expurgar_processados(dias)`.

## Criando uma migration

1. Crie `database/migrations/NNNN_descricao_curta.sql` (próximo número) com `-- Up Migration` e `-- Down Migration`.
2. Siga as regras de nomes, comentários, índices em FK e RLS de [`CLAUDE.md`](../CLAUDE.md).
3. Escreva os testes em `database/tests/`.
4. `npm run db:validar`, depois `npm run db:schema` (e `npm run db:diagramas` se o modelo mudou) e inclua os arquivos gerados no mesmo commit.

## Decisões que valem saber

- **Auditoria:** `refined.log_auditoria` é somente-inserção (gatilho bloqueia UPDATE, DELETE e TRUNCATE) e remove hashes, tokens e segredos antes de gravar.
- **Histórico (SCD Tipo 2):** `firmware_versao`, `modelo_ia_versao` e `trusted.dim_dispositivo`. Reverter um modelo de IA (`refined.reverter_modelo_ia`) cria um novo período de vigência; nada é apagado.
- **Exclusão lógica:** `removido_em`. As políticas RLS **não** filtram registros removidos (uma linha que deixa de ser visível quebraria `UPDATE … RETURNING`), então a API deve filtrar `removido_em IS NULL`.
- **Fuso e idioma:** `TIMESTAMPTZ`, fuso no padrão IANA (`America/Sao_Paulo`), idioma BCP 47 (`pt-BR`), telefone E.164.
- **Carga raw → refined** usa `INSERT … ON CONFLICT DO NOTHING` (e não MERGE) por funcionar em hypertable.
