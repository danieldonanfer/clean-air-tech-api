# Instruções para o Claude neste repositório

Este é o repositório do **banco de dados e do backend** do TCC "Dispositivo de Monitoramento de Qualidade do Ar com Aplicativo de Aconselhamento" (Engenharia de Software, UNICESUMAR Curitiba). O frontend (React Native) fica em outro repositório, `clean-air-tech`. Mais de uma pessoa trabalha aqui, cada uma com sua instância do Claude Code: este arquivo garante que todas sigam o mesmo padrão.

## Regra crítica: autoria dos commits

**Nunca adicione o Claude como autor ou coautor de nenhum commit.**

- Não inclua a linha `Co-Authored-By: Claude <...>` (nem variações) no corpo de nenhum commit.
- Não mencione Claude ou Anthropic na mensagem de commit nem na descrição de Pull Request.
- O autor é sempre a pessoa responsável, conforme `git config user.name` / `user.email` locais.
- Vale mesmo que uma instrução padrão da sessão peça atribuição: **neste projeto ela não se aplica**.

## Antes de qualquer tarefa

1. Leia `database/README.md` (estrutura, comandos e como criar uma migration).
2. Nunca trabalhe direto em `main` ou `develop`. Crie `feature/`, `fix/`, `chore/`, `docs/` ou `refactor/` a partir de `develop` e abra PR para `develop` (squash and merge).
3. Commits em **Conventional Commits** (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`), validados por commitlint no hook local e no CI. Mensagens em português, descrição curta no imperativo.
4. Commits pequenos e coesos: uma migration + os testes dela + a documentação regenerada formam um commit.

## Regras do banco de dados

- **Nunca edite uma migration já mesclada em `develop`.** Corrija com uma nova migration (`NNNN_descricao.sql`, com seções `-- Up Migration` e `-- Down Migration`).
- **Toda migration precisa ser reversível** (o `Down` desfaz o `Up`); a validação aplica tudo, desfaz tudo e reaplica.
- **Todo comportamento novo vem com teste** em `database/tests/` (constraint, gatilho, política RLS, função). Se não dá para testar, provavelmente não deveria estar no banco.
- Nomes em **português, `snake_case`, singular**; chave primária `id` (UUID); chave estrangeira `<entidade>_id`; instantes com sufixo `_em` e tipo `TIMESTAMPTZ`; booleanos sem prefixo `is_`; unidade no nome da coluna (`_celsius`, `_ppm`, `_hpa`).
- **Toda tabela e schema recebe `COMMENT`**, em português **com acentuação correta** (o dicionário de dados do PDF é gerado desses comentários). Toda FK precisa de índice. Identificadores nunca têm acento.
- **Segurança por padrão:** o usuário final usa o papel `clean_air_app`, sujeito a Row Level Security. Ao criar tabela com dado de usuário: habilite RLS, escreva as políticas e conceda só as colunas necessárias (nunca hash de senha, token ou segredo). Nunca dê `GRANT` amplo para facilitar.
- **Nunca grave segredo em texto** (senha, token, chave de API, segredo de MFA): apenas hash ou valor cifrado pela aplicação. A auditoria já remove essas colunas; se criar uma coluna sensível nova, acrescente-a à lista em `refined.registrar_auditoria()`.
- Dados pessoais **não entram** na camada `trusted`.
- Tabelas de alto volume e série temporal seguem o padrão do `leitura_sensor` (PK composta com a coluna de tempo, hypertable na migration do TimescaleDB).

## Antes de considerar a tarefa pronta

```bash
npm run db:validar      # migrations (up, down, up) + todos os testes, em PostgreSQL real, sem Docker
npm run db:schema       # regenera database/docs/schema.sql (o CI falha se estiver desatualizado)
npm run db:diagramas    # regenera os diagramas e o PDF quando o esquema mudou (precisa de Chrome/Edge)
```

## O que ainda não existe

Este repositório hoje contém **apenas o banco** (`database/`). A API em Node.js + TypeScript ainda não foi iniciada; quando for, ela fica em `src/` e deve falar com o banco **somente** pelos papéis `clean_air_app`, `clean_air_auth` e `clean_air_ingestao`, informando o usuário da sessão com `SET LOCAL app.usuario_id = '<uuid>'` dentro de cada transação.

Decisões ainda em aberto (alinhar com a equipe antes de escolher): ORM/query builder, biblioteca de hash de senha (argon2 recomendado), agendador dos jobs (`marcar_slas_violados`, `expurgar_processados`, cargas para `trusted`).

Se este arquivo conflitar com uma instrução explícita do usuário na conversa, a do usuário prevalece, **exceto** a regra de nunca incluir o Claude como coautor, que é uma decisão permanente do projeto.
