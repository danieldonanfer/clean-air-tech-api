import { criarApp } from './app.ts';
import { carregarConfig } from './config.ts';

const config = carregarConfig();
const app = await criarApp({ config });

async function encerrar(sinal: string): Promise<void> {
  app.fastify.log.info({ sinal }, 'encerrando');
  await app.fastify.close();
  await app.db.encerrar();
  process.exit(0);
}
process.on('SIGTERM', () => void encerrar('SIGTERM'));
process.on('SIGINT', () => void encerrar('SIGINT'));

try {
  await app.fastify.listen({ port: config.PORT, host: config.HOST });
} catch (erro) {
  app.fastify.log.error({ mensagem: erro instanceof Error ? erro.message : 'desconhecido' }, 'falha ao iniciar');
  process.exit(1);
}
