# Contrato da API de autenticação

Este documento é o contrato entre o back-end (`clean-air-tech-api`) e o front-end (`clean-air-tech`).
**Ele não muda sem avisar as duas pessoas que trabalham nele.** A versão legível por máquina está em
[`openapi.yaml`](openapi.yaml); se os dois divergirem, vale este texto e o `openapi.yaml` é corrigido.

## Convenções

- Prefixo `/v1`, corpo e resposta em JSON (`Content-Type: application/json`), datas em ISO 8601 (UTC).
- Rotas autenticadas usam `Authorization: Bearer <token>`.
- **Toda mensagem de erro vem em português e pronta para a tela**: o front exibe `erro.mensagem` como está.
- `GET /saude` fica fora do prefixo e responde `200 { "ok": true }`.

## Formato do usuário

Igual ao tipo `Usuario` do front (`src/types/usuario.ts`):

```json
{
  "nome": "Ana Silva",
  "apelido": "Ana",
  "email": "ana.silva@email.com",
  "telefone": "+5511987654321",
  "funcao": "Cliente",
  "idioma": "Português (Brasil)",
  "membroDesde": "março de 2023",
  "objetivo": "Monitoramento de ar e poluentes"
}
```

| Campo | Origem no banco | Observação |
|---|---|---|
| `nome` | `usuario.nome_completo` | |
| `apelido` | primeiro nome de `nome_completo` | |
| `email` | `usuario.email` | sempre em minúsculas |
| `telefone` | `usuario.telefone` | E.164; `""` quando não há telefone |
| `funcao` | papel em `usuario_papel` | `cliente_basico` → "Cliente"; `gestor_organizacao` → "Gestor" |
| `idioma` | `usuario.idioma_preferido` | `pt-BR` → "Português (Brasil)"; `en-US` → "English (US)"; `es-ES` → "Español"; outro valor devolve o próprio código |
| `membroDesde` | `usuario.criado_em` | mês e ano em pt-BR, minúsculo ("março de 2023") |
| `objetivo` | `usuario.objetivo_uso` | **texto** do objetivo, não a chave (ver abaixo) |

### Objetivo: a chave entra, o texto sai

No **cadastro** o front envia a **chave**; nas respostas o usuário traz o **texto** de exibição.

| Chave (entrada) | Texto (saída) |
|---|---|
| `ar` | Monitoramento de ar e poluentes |
| `alergia` | Controle de alergias e asma |
| `conforto` | Conforto e automação |
| `outro` | Outro objetivo |

> **Mudança necessária no front:** hoje `TelaCadastro.tsx` envia o *título* em `objetivo`
> (`OBJETIVOS.find(...)?.titulo`). Passa a enviar a própria chave (`objetivo` do estado da tela).
> Uma chave desconhecida é rejeitada com `422 VALIDACAO`.

## Formato de erro (todos os erros)

```json
{ "erro": { "codigo": "CREDENCIAIS_INVALIDAS", "mensagem": "E-mail ou senha incorretos.", "campos": { "senha": "..." } } }
```

`campos` só existe em `VALIDACAO`. Nesse caso `mensagem` repete a mensagem do **primeiro** campo inválido (na
ordem `nome`, `email`, `telefone`, `senha`, `objetivo`, `aceitouTermos`), então o front pode exibir só
`erro.mensagem`, como já faz hoje.

| Código | HTTP | Mensagem |
|---|---|---|
| `VALIDACAO` | 422 | a do primeiro campo inválido (ver abaixo) |
| `EMAIL_JA_CADASTRADO` | 409 | Já existe uma conta com esse e-mail. |
| `TELEFONE_JA_CADASTRADO` | 409 | Já existe uma conta com esse telefone. |
| `CREDENCIAIS_INVALIDAS` | 401 | E-mail ou senha incorretos. |
| `CONTA_BLOQUEADA` | 423 | Muitas tentativas de entrada. Tente novamente em N minutos. |
| `CONTA_SUSPENSA` | 403 | Esta conta está suspensa. Fale com o suporte. |
| `SESSAO_INVALIDA` | 401 | Sua sessão expirou. Entre novamente. |
| `CODIGO_INVALIDO` | 400 | Código inválido ou expirado. |
| `MUITAS_REQUISICOES` | 429 | Muitas tentativas. Aguarde alguns minutos e tente de novo. (traz `Retry-After`) |
| `NAO_ENCONTRADO` | 404 | Recurso não encontrado. |
| `ERRO_INTERNO` | 500 | Não foi possível concluir agora. Tente novamente em instantes. |

Mensagens de validação (as do front, mantidas):

| Campo | Mensagem |
|---|---|
| `nome` | Nome e e-mail são obrigatórios. (vazio) |
| `email` | Informe um e-mail válido. |
| `telefone` | Informe um telefone válido, com DDD. |
| `senha` | A senha não atende a um requisito: *requisito em minúsculas*. (ex.: "...: mínimo de 8 caracteres.") |
| `senha` (acima de 128) | A senha pode ter no máximo 128 caracteres. |
| `objetivo` | Escolha um objetivo válido. |
| `aceitouTermos` | É preciso aceitar os Termos de Uso. |

Requisitos de senha (os mesmos de `src/utils/senha.ts`): mínimo de 8 caracteres; letra maiúscula e minúscula;
pelo menos um número; um caractere especial; máximo de 128 caracteres.

## Endpoints

### `POST /v1/auth/cadastro`

Corpo: `{ "nome", "email", "telefone"?, "senha", "objetivo", "aceitouTermos" }`

- `telefone` é opcional e aceita o que o usuário digitar (`(11) 98765-4321`, `+55 11 98765-4321`). A API guarda
  em E.164; sem código de país, assume `+55`.
- `aceitouTermos` precisa ser `true`.
- Cria usuário, plano gratuito, papel `cliente_basico` e preferências de notificação padrão, **numa transação**.

`201 { "token": "...", "usuario": { ... } }` (já entra logado). Erros: `409 EMAIL_JA_CADASTRADO`,
`409 TELEFONE_JA_CADASTRADO`, `422 VALIDACAO`, `429`.

### `POST /v1/auth/login`

Corpo: `{ "email", "senha" }` → `200 { "token", "usuario" }`.
Erros: `401 CREDENCIAIS_INVALIDAS`, `423 CONTA_BLOQUEADA`, `403 CONTA_SUSPENSA`, `429`.

E-mail inexistente e senha errada dão a **mesma** resposta. Cinco falhas seguidas bloqueiam o login por 15 minutos.
Conta excluída responde como credencial inválida.

### `POST /v1/auth/logout` (Bearer)

Sem corpo → `204`. Erro: `401 SESSAO_INVALIDA`.

### `GET /v1/auth/eu` (Bearer)

→ `200 { "usuario": { ... } }`. Erro: `401 SESSAO_INVALIDA`. O front usa para restaurar a sessão.

### `POST /v1/auth/recuperacao/solicitar`

Corpo: `{ "email" }` → `202 { "expiraEmSegundos": 300 }`, **sempre**, exista a conta ou não.
O código de 6 dígitos sai **por e-mail**; ele **nunca** aparece na resposta.
Erro: `429` (3 pedidos por hora, por e-mail e por IP).

> **Mudança necessária no front:** `authService.pedirCodigo` hoje falha com "Não encontramos uma conta com
> esse e-mail." e devolve `codigoParaDemonstracao`. Com a API real as duas coisas somem: não existe mais erro
> de conta inexistente (revelaria quem tem cadastro) nem código na resposta. A tela `verificar-email` já trata
> `codigoDemo` como opcional.

### `POST /v1/auth/recuperacao/conferir`

Corpo: `{ "email", "codigo" }` → `204`. **Não consome** o código. Erros: `400 CODIGO_INVALIDO`, `429`.

Cada conferência errada conta como tentativa: na quinta, o código deixa de valer.

### `POST /v1/auth/recuperacao/redefinir`

Corpo: `{ "email", "codigo", "senha" }` → `204`. Consome o código e **revoga todas as sessões** da conta.
Erros: `400 CODIGO_INVALIDO`, `422 VALIDACAO`.

## Fase 2 (depois do fluxo principal no ar)

Todas com Bearer. Espelham `perfilService.ts` do front.

| Rota | Corpo | Sucesso | Erros |
|---|---|---|---|
| `GET /v1/perfil` | | `200 { usuario }` | `401` |
| `PATCH /v1/perfil` | `{ nome?, apelido?, email?, telefone? }` | `200 { usuario }` | `409`, `422 VALIDACAO`, `401` |
| `POST /v1/perfil/senha` | `{ senhaAtual, novaSenha }` | `204` | `422 VALIDACAO`, `401` |
| `DELETE /v1/perfil` | `{ confirmacao: "EXCLUIR", senha }` | `204` | `422 VALIDACAO`, `401` |

Mensagens: "A senha atual não confere." (troca), "Digite EXCLUIR para confirmar." e "A senha não confere."
(exclusão). A exclusão é lógica (`removido_em`), revoga as sessões e registra uma `solicitacao_titular_dados` do
tipo `exclusao`.

> `apelido` não tem coluna própria: é derivado do primeiro nome. Em `PATCH /v1/perfil`, enviar `apelido` sozinho
> é aceito e ignorado.

## Como o front integra

- Variável `EXPO_PUBLIC_API_URL` com a URL base (sem barra final).
- Guardar o `token` em memória (como hoje) e enviá-lo como `Authorization: Bearer`.
- Em qualquer `401 SESSAO_INVALIDA` fora do login, limpar a sessão e voltar para a tela de acesso.
- CORS: a API aceita `https://danieldonanfer.github.io`, `http://localhost:8081` e `http://localhost:19006`
  (mais o que vier de variável de ambiente). Se o front rodar em outra origem, avisar para incluir.

## Pontos em aberto (o que mudou em relação ao pedido original)

1. `objetivo` entra como chave e sai como texto (acima).
2. Acrescentei `409 TELEFONE_JA_CADASTRADO`: o banco tem índice único de telefone, e sem tratar isso o cadastro
   falharia com erro genérico.
3. Acrescentei `MUITAS_REQUISICOES` e `ERRO_INTERNO` ao catálogo de erros, para o front sempre receber o mesmo formato.
4. `VALIDACAO.mensagem` repete a do primeiro campo inválido (o pedido só dizia que a mensagem fica pronta para a tela).
5. O **cômodo** escolhido na etapa 3 do cadastro não faz parte do contrato: `DadosCadastro` não o envia e ele
   pertence a `local`, que é outra fase.
6. O **RNF 08.2** (cadastro em no máximo 3 etapas) segue em aberto no front, que tem 4 etapas. Não afeta a API.
