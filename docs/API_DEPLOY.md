# Colocando a API na nuvem

Três peças: **Supabase** (banco), **Render** (API) e o **Brevo** (e-mail). Tudo no plano gratuito.

> **Nunca** cole senhas ou chaves no chat, em issue, em PR ou no repositório. Elas vão só nas variáveis de ambiente do Render e do seu `.env` local (que o Git ignora).

Este roteiro foi escrito sem acesso ao Supabase nem ao Render, então os pontos marcados com **conferir** dependem de como os painéis estão hoje.

## 1. Banco no Supabase

1. Crie um projeto em <https://supabase.com> e guarde a senha do banco (a do `postgres`).
2. Em **Project Settings → Database**, copie as strings de conexão. Duas coisas importam:
   - A conexão **direta** (`db.<ref>.supabase.co:5432`) costuma ser só IPv6. Se a sua rede ou o Render não tiver IPv6, use a URL do **pooler** (`aws-0-<região>.pooler.supabase.com`), cujo usuário é `postgres.<ref>`. **Conferir** no painel qual está disponível.
   - As migrations usam bloqueio de sessão: aplique pela conexão direta ou pelo pooler em **modo sessão** (porta 5432), não pelo modo transação (6543).
3. Rode **um comando só**, da sua máquina. Ele aplica as migrations, cria o papel de login da API (`clean_air_api`, sem privilégio próprio, só pode virar `clean_air_auth` ou `clean_air_app` dentro de uma transação) e **confere** que a troca de papel funciona. As três variáveis ficam só no seu terminal, nunca em arquivo do repositório, e o script não imprime nenhuma delas:

   ```bash
   # Git Bash / Linux / macOS
   ADMIN_DATABASE_URL='postgres://postgres.<ref>:<SENHA-DO-POSTGRES>@<host>:5432/postgres'    API_DATABASE_URL='postgres://clean_air_api.<ref>:<SENHA-DA-API>@<host>:5432/postgres'    API_DB_SENHA='<SENHA-DA-API>'    npm run db:nuvem
   ```

   ```powershell
   # PowerShell
   $env:ADMIN_DATABASE_URL='postgres://postgres.<ref>:<SENHA-DO-POSTGRES>@<host>:5432/postgres'
   $env:API_DATABASE_URL='postgres://clean_air_api.<ref>:<SENHA-DA-API>@<host>:5432/postgres'
   $env:API_DB_SENHA='<SENHA-DA-API>'
   npm run db:nuvem
   ```

   - `<SENHA-DA-API>` é uma senha **nova, forte (16+ caracteres) e diferente da do `postgres`**. Use a mesma nas duas variáveis.
   - No pooler do Supabase o usuário leva o ID do projeto (`clean_air_api.<ref>`); na conexão direta é só `clean_air_api`.
   - O Supabase **não tem TimescaleDB**. A migration `0009` já vira no-op sem a extensão (`refined.leitura_sensor` fica como tabela comum).
   - O script é repetível: migrations já aplicadas são puladas e, se o papel existir, só a senha é atualizada.
   - **A migration `0001` cria os papéis `clean_air_*`.** O usuário `postgres` do Supabase tem `CREATEROLE`, mas não é superusuário. **Conferir**: se o comando falhar logo no passo 1, **não edite a migration**; avise para tratarmos com uma nova migration ou um passo manual documentado aqui.
   - Saída esperada: `1/4 migrations`, `2/4 papel clean_air_api`, `3/4 sem SET ROLE o papel de login não lê nada: OK`, `4/4 SET LOCAL ROLE clean_air_auth e clean_air_app: OK`, `Banco pronto para a API.`

4. A `DATABASE_URL` da API no Render é a `API_DATABASE_URL` acima. A API usa `SET LOCAL ROLE` dentro de transações, então funciona tanto no pooler em modo sessão quanto em modo transação.

Se o passo 4/4 falhar, a troca de papel não está valendo naquele ambiente (por exemplo, por causa do pooler): pare e avise, porque sem ela a API não funciona.

## 2. E-mail

> **O plano gratuito do Render bloqueia SMTP** (portas 25, 465 e 587): com `EMAIL_MODE=smtp` o envio dá `Connection timeout`. Por isso o caminho padrão é a **API HTTPS do Brevo** (porta 443, que não é bloqueada). O SMTP continua disponível para quem hospedar em outro lugar.

**Brevo (plano gratuito, 300 e-mails por dia):**
1. Crie a conta em <https://www.brevo.com> e, em **Senders**, adicione e **verifique** o e-mail remetente (ele manda um link de confirmação). O Brevo só envia de um remetente verificado, mas entrega para qualquer destinatário.
2. Em **SMTP & API → API Keys**, gere uma chave de API (começa com `xkeysib-`).
3. No Render: `EMAIL_MODE=brevo`, `BREVO_API_KEY=<a chave>` e `EMAIL_FROM=Clean Air Tech <o-email-verificado>`. O `EMAIL_FROM` **precisa ser o remetente verificado**, senão o Brevo recusa (o log mostra `Brevo respondeu 400: Sender not valid`).

**SMTP genérico** (`EMAIL_MODE=smtp`, só fora do plano gratuito do Render), por exemplo Gmail com senha de app: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`.

## 3. API no Render

1. Em <https://render.com> → **New → Blueprint** e aponte para este repositório. O `render.yaml` cria o serviço `clean-air-tech-api` (plano free, região Virginia, deploy da `develop`).
2. Preencha as variáveis que o Blueprint pede (as `sync: false`):

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | a do passo 1.5 (papel `clean_air_api`) |
   | `CORS_ORIGINS` | só se o front estiver em outra origem além de `danieldonanfer.github.io` e `localhost` |
   | `EMAIL_FROM`, `BREVO_API_KEY` | do passo 2 |

   `SEGREDO_CODIGOS` o próprio Render gera. **Não troque depois de ter usuários com código pendente**: os códigos em andamento deixam de valer (sem prejuízo, só pedir outro).
3. Quando subir, teste: `curl https://<seu-servico>.onrender.com/saude` → `{"ok":true}`.
4. Entregue a **URL** ao Daniel: ele a coloca em `EXPO_PUBLIC_API_URL` no front e na build do GitHub Pages.

### O plano gratuito "dorme"

Depois de uns 15 minutos sem requisições o Render desliga o serviço, e a **primeira chamada leva ~30 segundos**. Antes de apresentar:

- acorde a API abrindo `/saude` uns 2 minutos antes; e/ou
- agende um ping a cada 10 minutos (por exemplo um monitor gratuito no UptimeRobot apontando para `/saude`).

## 4. Conferindo ponta a ponta

```bash
API=https://<seu-servico>.onrender.com
curl -s $API/saude
curl -s -X POST $API/v1/auth/cadastro -H 'content-type: application/json' \
  -d '{"nome":"Teste","email":"voce@exemplo.com","senha":"Purifica@2025","objetivo":"ar","aceitouTermos":true}'
curl -s -X POST $API/v1/auth/recuperacao/solicitar -H 'content-type: application/json' \
  -d '{"email":"voce@exemplo.com"}'     # o código chega por e-mail
```

Se o e-mail não chegar, olhe os **logs do Render**: a falha de envio aparece como `Falha ao enviar o e-mail de recuperação` (a API responde normalmente ao front, de propósito, para não revelar quais contas existem).
