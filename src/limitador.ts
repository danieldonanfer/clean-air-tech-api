/**
 * Limitador de janela deslizante, em memória.
 *
 * Fica em memória de propósito: o limite por e-mail precisa valer também para e-mails que não têm
 * conta (senão a resposta revelaria quais existem), então não dá para guardar na tabela de usuários.
 * Com uma única instância da API (o caso do TCC) isso basta; com várias, passaria para um Redis.
 */
export class Limitador {
  private readonly marcas = new Map<string, number[]>();

  constructor(
    private readonly maximo: number,
    private readonly janelaMs: number,
    private readonly agora: () => number = Date.now,
  ) {}

  /** Registra uma tentativa. Devolve `null` se passou, ou os segundos até poder tentar de novo. */
  tentar(chave: string): number | null {
    const agora = this.agora();
    const recentes = (this.marcas.get(chave) ?? []).filter((t) => agora - t < this.janelaMs);
    if (recentes.length >= this.maximo) {
      this.marcas.set(chave, recentes);
      const maisAntiga = recentes[0] ?? agora;
      return Math.max(1, Math.ceil((maisAntiga + this.janelaMs - agora) / 1000));
    }
    recentes.push(agora);
    this.marcas.set(chave, recentes);
    if (this.marcas.size > 10_000) this.limpar(agora);
    return null;
  }

  private limpar(agora: number): void {
    for (const [chave, marcas] of this.marcas) {
      if (marcas.every((t) => agora - t >= this.janelaMs)) this.marcas.delete(chave);
    }
  }
}
