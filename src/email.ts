import nodemailer from 'nodemailer';
import type { Config } from './config.ts';

export interface Destinatario {
  email: string;
  nome: string;
}

export interface Mailer {
  enviarCodigoRecuperacao(para: Destinatario, codigo: string): Promise<void>;
}

/** Registro mínimo que o e-mail precisa para avisar de falha, sem depender do Fastify. */
export interface Registro {
  info(dados: object, mensagem: string): void;
  error(dados: object, mensagem: string): void;
}

const VALIDADE_MINUTOS = 5;

function montarMensagem(para: Destinatario, codigo: string) {
  const primeiroNome = para.nome.trim().split(/\s+/)[0] ?? '';
  const assunto = `Seu código do Clean Air Tech: ${codigo}`;
  const texto = [
    `Olá, ${primeiroNome}!`,
    '',
    'Use este código para redefinir a sua senha:',
    '',
    `    ${codigo}`,
    '',
    `Ele vale por ${VALIDADE_MINUTOS} minutos e só pode ser usado uma vez.`,
    'Se não foi você quem pediu, ignore este e-mail: a sua senha continua a mesma.',
    '',
    'Clean Air Tech',
  ].join('\n');
  const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;padding:24px;background:#f2f2f7;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;padding:32px">
    <p style="margin:0 0 16px;font-size:16px">Olá, ${escaparHtml(primeiroNome)}!</p>
    <p style="margin:0 0 20px;font-size:15px;color:#475569">Use este código para redefinir a sua senha:</p>
    <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:8px;text-align:center;color:#0369a1">${codigo}</p>
    <p style="margin:0 0 8px;font-size:14px;color:#475569">Ele vale por ${VALIDADE_MINUTOS} minutos e só pode ser usado uma vez.</p>
    <p style="margin:0;font-size:14px;color:#64748b">Se não foi você quem pediu, ignore este e-mail: a sua senha continua a mesma.</p>
  </div>
</body></html>`;
  return { assunto, texto, html };
}

function escaparHtml(valor: string): string {
  return valor.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const URL_BREVO = 'https://api.brevo.com/v3/smtp/email';

/** Separa `Nome <email@dominio>` (ou só `email@dominio`) no formato que a API do Brevo pede. */
export function separarRemetente(de: string): { name?: string; email: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>\s]+)>\s*$/.exec(de);
  if (m) {
    const nome = m[1]?.trim();
    return nome ? { name: nome, email: m[2]! } : { email: m[2]! };
  }
  return { email: de.trim() };
}

export function criarMailer(config: Config, log: Registro, buscar: typeof fetch = fetch): Mailer {
  if (config.EMAIL_MODE === 'console') {
    // Só para desenvolvimento (a configuração recusa este modo em produção).
    return {
      async enviarCodigoRecuperacao(para, codigo) {
        log.info({ para: para.email, codigo }, 'E-mail simulado (EMAIL_MODE=console)');
      },
    };
  }

  if (config.EMAIL_MODE === 'brevo') {
    const chave = config.BREVO_API_KEY ?? '';
    const remetente = separarRemetente(config.EMAIL_FROM);
    return {
      async enviarCodigoRecuperacao(para, codigo) {
        const { assunto, texto, html } = montarMensagem(para, codigo);
        const resposta = await buscar(URL_BREVO, {
          method: 'POST',
          headers: { 'api-key': chave, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            sender: remetente,
            to: [{ email: para.email, name: para.nome }],
            subject: assunto,
            textContent: texto,
            htmlContent: html,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resposta.ok) {
          // O Brevo explica o motivo (ex.: remetente não verificado). Nunca inclui a chave.
          const motivo = await resposta.json().then((j) => String((j as { message?: unknown }).message ?? ''), () => '');
          throw new Error(`Brevo respondeu ${resposta.status}${motivo ? `: ${motivo.slice(0, 200)}` : ''}`);
        }
      },
    };
  }

  const transporte = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });

  return {
    async enviarCodigoRecuperacao(para, codigo) {
      const { assunto, texto, html } = montarMensagem(para, codigo);
      await transporte.sendMail({ from: config.EMAIL_FROM, to: para.email, subject: assunto, text: texto, html });
    },
  };
}

export { montarMensagem };
