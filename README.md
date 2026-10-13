# clean-air-tech-api

Banco de dados e backend do TCC **Dispositivo de Monitoramento de Qualidade do Ar com Aplicativo de Aconselhamento** (Engenharia de Software, UNICESUMAR Curitiba).

Equipe: Daniel Fernando Abreu de Moraes, Gabriel Guedes Archanjo, Lorena Andrade de Souza, Vanusa da Silva Almeida.

> **Estado atual:** o banco de dados está pronto e validado (PostgreSQL + TimescaleDB, 43 tabelas, migrations reversíveis, testes automatizados, diagramas gerados do banco real). A **API de autenticação** (cadastro, login, logout, esqueci a senha e redefinição) está implementada em `src/`, com testes de integração contra um PostgreSQL real. O frontend está em [`clean-air-tech`](https://github.com/danieldonanfer/clean-air-tech).

## Comece por aqui

| Quero... | Veja |
|---|---|
| Entender o modelo do banco | [`database/docs/Esquema_Banco_Clean_Air_Tech.pdf`](database/docs/Esquema_Banco_Clean_Air_Tech.pdf) |
| Rodar, testar e criar migrations | [`database/README.md`](database/README.md) |
| Integrar o front à API | [`docs/API_CONTRATO.md`](docs/API_CONTRATO.md) e [`docs/openapi.yaml`](docs/openapi.yaml) |
| Colocar a API na nuvem | [`docs/API_DEPLOY.md`](docs/API_DEPLOY.md) |
| Regras para quem (ou qual Claude) mexer aqui | [`CLAUDE.md`](CLAUDE.md) |

## Início rápido

```bash
npm install
npm run db:validar   # aplica, desfaz e reaplica as migrations e roda os testes do banco (sem Docker)
npm test             # testes de integração da API, em PostgreSQL embutido (sem Docker)
npm run typecheck
```

## API

Node 22+, TypeScript, Fastify, zod, `pg` direto (sem ORM, a lógica está no banco), argon2id, nodemailer.

```
src/
  config.ts      variáveis de ambiente validadas (nunca mostra valores no erro)
  db.ts          transação sob um papel do banco (SET LOCAL ROLE) + app.usuario_id
  seguranca.ts   argon2id, token de sessão (SHA-256), código de 6 dígitos (HMAC)
  validacao.ts   regras de entrada e mensagens em português, as mesmas do front
  auth.ts        cadastro, login, sessão, logout e recuperação de senha
  app.ts         Fastify: CORS, helmet, limite global, tratamento de erros, rotas
  email.ts       envio por SMTP (ou console, só em desenvolvimento)
tests/           integração (PostgreSQL real) e unidade
```

### Rodando localmente

1. Suba um PostgreSQL e aplique as migrations com um usuário **administrativo**:

   ```bash
   DATABASE_URL=postgres://postgres:senha@localhost:5432/clean_air npm run db:migrate
   ```

2. Crie o papel de login da API. Ele **não tem privilégio próprio** (`NOINHERIT`): cada transação assume `clean_air_auth` (cadastro, login, recuperação) ou `clean_air_app` (usuário autenticado, sob RLS). Se o código esquecer o `SET LOCAL ROLE`, a consulta falha em vez de rodar com poder demais.

   ```sql
   CREATE ROLE clean_air_api LOGIN PASSWORD 'troque-esta-senha' NOINHERIT
     IN ROLE clean_air_auth, clean_air_app;
   ```

3. Copie `.env.example` para `.env`, ajuste `DATABASE_URL` (com `clean_air_api`) e gere o `SEGREDO_CODIGOS`. Com `EMAIL_MODE=console` o código de recuperação aparece no terminal.

4. `npm run dev` (recarrega ao salvar) ou `npm run build && npm start`. `GET /saude` responde `{ "ok": true }`.

### Decisões de segurança

| Tema | Como é |
|---|---|
| Senha | argon2id (19 MiB, 2 passes); mínimo de 8 e máximo de 128 caracteres; as 4 regras do front são repetidas no servidor |
| Login | e-mail inexistente e senha errada: mesma resposta, mesmo custo (hash fictício) e piso de tempo; 5 falhas bloqueiam por 15 min; o bloqueio nunca vale para a recuperação |
| Sessão | token opaco de 32 bytes; o banco guarda só o SHA-256; 7 dias; logout e redefinição de senha revogam |
| Recuperação | código de 6 dígitos (`crypto.randomInt`), guardado como HMAC com `SEGREDO_CODIGOS`; 300 s, uso único, 5 tentativas; um pedido novo invalida os anteriores; 3 pedidos por hora por e-mail e por IP; a resposta é igual exista a conta ou não |
| Banco | papel de login sem privilégios; `clean_air_auth` só onde precisa; `clean_air_app` sob RLS e sem acesso ao hash |
| Borda | HTTPS na nuvem, CORS por lista, helmet, corpo de até 16 KB, limite global por minuto |
| Logs | uma linha por requisição, sem IP, corpo, cabeçalhos, token, código ou e-mail |

Limites conhecidos (aceitos para o TCC): os contadores de limite de requisições ficam em memória (uma instância só; com várias, passam para um Redis), e o bloqueio por conta permite que alguém trave a conta de outra pessoa por 15 minutos errando a senha de propósito (é o desenho pedido; o desbloqueio pela recuperação de senha existe).

## Fluxo de trabalho

- `main` (estável) e `develop` (integração). Todo trabalho em `feature/*`, `fix/*`, `chore/*`, `docs/*` ou `refactor/*` a partir de `develop`, com Pull Request e squash and merge.
- Commits em [Conventional Commits](https://www.conventionalcommits.org/pt-br/), validados por commitlint.
- O CI valida o banco em PostgreSQL puro e na imagem oficial do TimescaleDB (`.github/workflows/database.yml`) e a API (`.github/workflows/api.yml`: typecheck, build e testes de integração).
