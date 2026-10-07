# clean-air-tech-api

Banco de dados e backend do TCC **Dispositivo de Monitoramento de Qualidade do Ar com Aplicativo de Aconselhamento** (Engenharia de Software, UNICESUMAR Curitiba).

Equipe: Daniel Fernando Abreu de Moraes, Gabriel Guedes Archanjo, Lorena Andrade de Souza, Vanusa da Silva Almeida.

> **Estado atual:** o banco de dados está pronto e validado (PostgreSQL + TimescaleDB, 43 tabelas, migrations reversíveis, testes automatizados, diagramas gerados do banco real). A API em Node.js + TypeScript ainda não foi iniciada. O frontend está em [`clean-air-tech`](https://github.com/danieldonanfer/clean-air-tech).

## Comece por aqui

| Quero... | Veja |
|---|---|
| Entender o modelo do banco | [`database/docs/Esquema_Banco_Clean_Air_Tech.pdf`](database/docs/Esquema_Banco_Clean_Air_Tech.pdf) |
| Rodar, testar e criar migrations | [`database/README.md`](database/README.md) |
| Regras para quem (ou qual Claude) mexer aqui | [`CLAUDE.md`](CLAUDE.md) |

## Início rápido

```bash
npm install
npm run db:validar   # aplica, desfaz e reaplica as migrations e roda os testes (sem Docker)
```

## Fluxo de trabalho

- `main` (estável) e `develop` (integração). Todo trabalho em `feature/*`, `fix/*`, `chore/*`, `docs/*` ou `refactor/*` a partir de `develop`, com Pull Request e squash and merge.
- Commits em [Conventional Commits](https://www.conventionalcommits.org/pt-br/), validados por commitlint.
- O CI (`.github/workflows/database.yml`) valida o banco em PostgreSQL puro e na imagem oficial do TimescaleDB.
