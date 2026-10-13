// Gera os diagramas (Mermaid -> SVG/PNG) e o PDF "Esquema do banco" A PARTIR DO BANCO REAL:
// aplica as migrations em um PostgreSQL descartavel, le o catalogo e desenha o que existe de fato.
// Requer Chrome ou Edge instalado (usado pelo mermaid-cli e para imprimir o PDF).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrar, raiz, subirBanco } from './ambiente.mjs';

const saida = path.join(raiz, 'database', 'docs');
const pastaDiagramas = path.join(saida, 'diagramas');
mkdirSync(pastaDiagramas, { recursive: true });

const NAVEGADORES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const navegador = NAVEGADORES.find((p) => existsSync(p));
if (!navegador) throw new Error('Chrome/Edge nao encontrado. Defina CHROME_PATH.');

const DOMINIOS = [
  {
    id: 'identidade', camada: 'refined', titulo: 'Identidade, autenticação e controle de acesso',
    tabelas: ['usuario', 'colaborador', 'token_verificacao', 'login_provedor_externo', 'mfa_configuracao', 'sessao_autenticacao', 'papel', 'permissao', 'papel_permissao', 'usuario_papel', 'colaborador_papel'],
    intro: 'Contas de clientes e da equipe interna; login por e-mail, telefone e provedores sociais (Google, Apple, Facebook); MFA, sessões e recuperação de senha; e o RBAC (papéis e permissões) compartilhado entre clientes e colaboradores.',
  },
  {
    id: 'organizacoes', camada: 'refined', titulo: 'Organizações e ambientes',
    tabelas: ['organizacao', 'usuario_organizacao', 'local', 'local_membro'],
    intro: 'Organizações clientes (escola, hospital, empresa) ligadas aos usuários por vínculo (membership), e os ambientes físicos monitorados, em hierarquia (casa › cômodo) e compartilháveis entre usuários.',
  },
  {
    id: 'frota', camada: 'refined', titulo: 'Gestão de frota de dispositivos',
    tabelas: ['lote_fabricacao', 'dispositivo', 'dispositivo_estado', 'grupo_dispositivo', 'dispositivo_grupo', 'firmware_versao', 'feature_flag', 'certificacao_dispositivo', 'garantia_dispositivo'],
    intro: 'Cadastro e operação do parque de dispositivos: estado desejado × reportado (Device Shadow), grupos para operação em lote, firmware com histórico (SCD Tipo 2), feature flags de rollout, lotes de fabricação, certificações e garantias.',
  },
  {
    id: 'leituras', camada: 'refined', titulo: 'Leituras, inteligência artificial e alertas',
    tabelas: ['modelo_ia_versao', 'leitura_sensor', 'evento_sonoro_detectado', 'alerta', 'recomendacao', 'notificacao_enviada', 'preferencia_notificacao'],
    intro: 'Medições dos sensores (hypertable TimescaleDB), eventos sonoros classificados por TinyML, versões dos modelos de IA com rollback, alertas, recomendações e notificações com preferências por usuário.',
  },
  {
    id: 'negocio', camada: 'refined', titulo: 'Negócio, suporte e integrações',
    tabelas: ['assinatura_plano', 'saude_conta', 'ticket_suporte', 'integracao_externa'],
    intro: 'Planos de assinatura, saúde da conta (risco de cancelamento), tickets de suporte com controle de SLA e integrações com Alexa, IFTTT, Google Home e Home Assistant.',
  },
  {
    id: 'governanca', camada: 'refined', titulo: 'Governança, auditoria e LGPD',
    tabelas: ['log_auditoria', 'solicitacao_titular_dados'],
    intro: 'Trilha de auditoria imutável (somente inserção, sem segredos) e pedidos de titulares de dados da LGPD (acesso, correção, exclusão e portabilidade) com prazo de resposta.',
  },
  {
    id: 'raw', camada: 'raw', titulo: 'Camada raw (ingestão)',
    tabelas: ['lote_ingestao', 'leitura_bruta'],
    intro: 'Dado bruto, como chegou do dispositivo, com retenção curta. É a origem da carga deduplicada para a camada refined, e registra o motivo de cada linha rejeitada.',
  },
  {
    id: 'trusted', camada: 'trusted', titulo: 'Camada trusted (análise)',
    tabelas: ['dim_tempo', 'dim_local', 'dim_dispositivo', 'fato_leitura'],
    intro: 'Esquema estrela para análise: fato horário de leituras e dimensões de tempo, local e dispositivo (SCD Tipo 2). Não contém dados pessoais.',
  },
];

const TIPOS = { 'timestamp with time zone': 'timestamptz', 'time without time zone': 'time', 'character varying': 'varchar', 'double precision': 'float8' };
const tipoCurto = (t) => TIPOS[t] ?? t.replace(/\(.*\)/, '').replace(/\s+/g, '_');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------- introspeccao
async function introspectar(c) {
  const q = async (sql, p = []) => (await c.query(sql, p)).rows;
  const tabelas = await q(`
    SELECT c.oid::int AS oid, n.nspname AS esquema, c.relname AS nome, obj_description(c.oid, 'pg_class') AS comentario
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname IN ('raw', 'refined', 'trusted') ORDER BY 2, 3`);
  const oids = tabelas.map((t) => t.oid);
  const colunas = await q(`
    SELECT a.attrelid::int AS oid, a.attnum AS num, a.attname AS nome, format_type(a.atttypid, a.atttypmod) AS tipo,
           a.attnotnull AS obrigatoria, pg_get_expr(d.adbin, d.adrelid) AS padrao, col_description(a.attrelid, a.attnum) AS comentario
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attnum > 0 AND NOT a.attisdropped AND a.attrelid = ANY($1::oid[]) ORDER BY a.attrelid, a.attnum`, [oids]);
  const restricoes = await q(`
    SELECT conrelid::int AS oid, conname AS nome, contype AS tipo, conkey AS cols, confrelid::int AS ref_oid, confkey AS ref_cols, confdeltype AS apaga
    FROM pg_constraint WHERE conrelid = ANY($1::oid[])`, [oids]);
  const unicos = await q(`
    SELECT indrelid::int AS oid, string_to_array(indkey::text, ' ')::int2[] AS cols
    FROM pg_index WHERE indrelid = ANY($1::oid[]) AND indisunique AND indpred IS NULL`, [oids]);
  const [totais] = await q(`
    SELECT
      (SELECT count(*) FROM pg_indexes WHERE schemaname IN ('raw','refined','trusted'))::int AS indices,
      (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE NOT t.tgisinternal AND n.nspname IN ('raw','refined','trusted'))::int AS gatilhos,
      (SELECT count(*) FROM pg_policies WHERE schemaname IN ('raw','refined','trusted'))::int AS politicas,
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('raw','refined','trusted') AND p.prokind = 'f')::int AS funcoes`);

  const porOid = new Map(tabelas.map((t) => [t.oid, { ...t, colunas: [], pk: [], fks: [], unicos: [], checks: 0 }]));
  for (const col of colunas) porOid.get(col.oid).colunas.push(col);
  const nomeCol = (oid, num) => porOid.get(oid).colunas.find((x) => x.num === num).nome;
  for (const r of restricoes) {
    const t = porOid.get(r.oid);
    if (r.tipo === 'p') t.pk = r.cols.map((n) => nomeCol(r.oid, n));
    if (r.tipo === 'u') t.unicos.push(r.cols.map((n) => nomeCol(r.oid, n)));
    if (r.tipo === 'c') t.checks += 1;
    if (r.tipo === 'f') {
      t.fks.push({ nome: r.nome, cols: r.cols.map((n) => nomeCol(r.oid, n)), refOid: r.ref_oid, refCols: r.ref_cols.map((n) => nomeCol(r.ref_oid, n)), apaga: r.apaga });
    }
  }
  for (const u of unicos) {
    if (u.cols.includes(0)) continue; // indice sobre expressao (ex.: lower(email)): nao e coluna simples
    const t = porOid.get(u.oid);
    t.unicos.push(u.cols.map((n) => nomeCol(u.oid, n)));
  }
  for (const t of porOid.values()) {
    for (const fk of t.fks) {
      fk.refTabela = porOid.get(fk.refOid).nome;
      const obrig = fk.cols.every((n) => t.colunas.find((x) => x.nome === n).obrigatoria);
      const mesmaLista = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
      fk.paiObrigatorio = obrig;
      fk.umParaUm = mesmaLista(fk.cols, t.pk) || t.unicos.some((u) => mesmaLista(u, fk.cols));
    }
  }
  const lista = [...porOid.values()];
  const checks = lista.reduce((s, t) => s + t.checks, 0);
  return { tabelas: lista, totais: { ...totais, checks, colunas: colunas.length, fks: lista.reduce((s, t) => s + t.fks.length, 0) } };
}

// ---------------------------------------------------------------- mermaid
function dominioDe(nome) {
  return DOMINIOS.find((d) => d.tabelas.includes(nome));
}

function mermaidER(dom, info) {
  const porNome = new Map(info.tabelas.map((t) => [t.nome, t]));
  const linhas = ['erDiagram'];
  for (const nome of dom.tabelas) {
    const t = porNome.get(nome);
    linhas.push(`  ${nome} {`);
    for (const col of t.colunas) {
      const chaves = [];
      if (t.pk.includes(col.nome)) chaves.push('PK');
      if (t.fks.some((fk) => fk.cols.includes(col.nome))) chaves.push('FK');
      if (!t.pk.includes(col.nome) && t.unicos.some((u) => u.length === 1 && u[0] === col.nome)) chaves.push('UK');
      linhas.push(`    ${tipoCurto(col.tipo)} ${col.nome}${chaves.length ? ' ' + chaves.join(',') : ''}`);
    }
    linhas.push('  }');
  }
  for (const nome of dom.tabelas) {
    const t = porNome.get(nome);
    for (const fk of t.fks) {
      const pai = fk.paiObrigatorio ? '||' : '|o';
      const filho = fk.umParaUm ? 'o|' : 'o{';
      linhas.push(`  ${fk.refTabela} ${pai}--${filho} ${nome} : "${fk.cols.join(', ')}"`);
    }
  }
  return linhas.join('\n') + '\n';
}

function mermaidVisaoGeral(info) {
  const linhas = ['flowchart LR'];
  const rotulo = (d) => `${d.id}["<b>${d.titulo}</b><br/><i>${d.tabelas.join(' · ')}</i>"]`;
  const camadas = { raw: 'Camada RAW', refined: 'Camada REFINED', trusted: 'Camada TRUSTED' };
  for (const camada of ['raw', 'refined', 'trusted']) {
    linhas.push(`  subgraph ${camada}_g["${camadas[camada]}"]`);
    for (const d of DOMINIOS.filter((x) => x.camada === camada)) linhas.push(`    ${rotulo(d)}`);
    linhas.push('  end');
  }
  const arestas = new Map();
  for (const t of info.tabelas) {
    for (const fk of t.fks) {
      const de = dominioDe(t.nome).id;
      const para = dominioDe(fk.refTabela).id;
      if (de === para) continue;
      const chave = `${de}>${para}`;
      arestas.set(chave, (arestas.get(chave) ?? 0) + 1);
    }
  }
  for (const [chave, n] of arestas) {
    const [de, para] = chave.split('>');
    linhas.push(`  ${de} -->|"${n} FK"| ${para}`);
  }
  linhas.push('  raw ==>|"carga + deduplicação"| leituras');
  linhas.push('  leituras ==>|"ETL horário (SCD2)"| trusted');
  linhas.push('  classDef camadaRaw fill:#f1f5f9,stroke:#64748b,color:#0f172a');
  linhas.push('  classDef camadaRefined fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e');
  linhas.push('  classDef camadaTrusted fill:#dcfce7,stroke:#15803d,color:#14532d');
  linhas.push(`  class raw camadaRaw`);
  linhas.push(`  class ${DOMINIOS.filter((d) => d.camada === 'refined').map((d) => d.id).join(',')} camadaRefined`);
  linhas.push(`  class trusted camadaTrusted`);
  return linhas.join('\n') + '\n';
}

// ---------------------------------------------------------------- renderizacao
const configPuppeteer = path.join(pastaDiagramas, '.puppeteer.json');
writeFileSync(configPuppeteer, JSON.stringify({ executablePath: navegador, args: ['--no-sandbox', '--disable-gpu'] }));
const cliMermaid = path.join(raiz, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js');

function renderizar(nomeBase, mmd) {
  const arquivoMmd = path.join(pastaDiagramas, `${nomeBase}.mmd`);
  writeFileSync(arquivoMmd, mmd, 'utf8');
  for (const [formato, extra] of [['svg', []], ['png', ['-s', '2']]]) {
    execFileSync(process.execPath, [cliMermaid, '-i', arquivoMmd, '-o', path.join(pastaDiagramas, `${nomeBase}.${formato}`), '-p', configPuppeteer, '-b', 'white', '-q', ...extra], { stdio: 'inherit' });
  }
  return readFileSync(path.join(pastaDiagramas, `${nomeBase}.svg`), 'utf8');
}

// ---------------------------------------------------------------- PDF
function tabelaDicionario(t) {
  const fkDe = (col) => t.fks.find((fk) => fk.cols.includes(col));
  const linhas = t.colunas.map((col) => {
    const chaves = [];
    if (t.pk.includes(col.nome)) chaves.push('PK');
    const fk = fkDe(col.nome);
    if (fk) chaves.push(`FK → ${fk.refTabela}`);
    if (!t.pk.includes(col.nome) && t.unicos.some((u) => u.length === 1 && u[0] === col.nome)) chaves.push('único');
    return `<tr><td class="mono">${esc(col.nome)}</td><td class="mono">${esc(col.tipo)}</td><td>${col.obrigatoria ? 'sim' : 'não'}</td>
      <td class="mono">${esc(col.padrao ?? '')}</td><td>${esc(chaves.join(', '))}</td><td>${esc(col.comentario ?? '')}</td></tr>`;
  });
  return `<h4>${esc(t.esquema)}.${esc(t.nome)}</h4><p class="desc">${esc(t.comentario ?? '')}</p>
    <table class="dic"><thead><tr><th>Coluna</th><th>Tipo</th><th>Obrig.</th><th>Padrão</th><th>Chave</th><th>Descrição</th></tr></thead><tbody>${linhas.join('')}</tbody></table>`;
}

function montarHtml(info, svgs, testes) {
  const { totais } = info;
  const migracoes = readdirSync(path.join(raiz, 'database', 'migrations')).filter((f) => f.endsWith('.sql')).length;
  const porNome = new Map(info.tabelas.map((t) => [t.nome, t]));
  const cartoes = [
    [info.tabelas.length, 'tabelas'], [totais.colunas, 'colunas'], [totais.fks, 'chaves estrangeiras'], [totais.checks, 'regras CHECK'],
    [totais.indices, 'índices'], [totais.gatilhos, 'gatilhos'], [totais.politicas, 'políticas RLS'], [totais.funcoes, 'funções'], [testes, 'testes automatizados'],
  ].map(([n, r]) => `<div class="card"><b>${n}</b><span>${r}</span></div>`).join('');

  const secoes = DOMINIOS.map((d, i) => {
    const lista = d.tabelas.map((n) => `<tr><td class="mono">${esc(n)}</td><td>${esc(porNome.get(n).comentario ?? '')}</td></tr>`).join('');
    return `<section class="dominio">
      <h2>${i + 1}. ${esc(d.titulo)}</h2><p>${esc(d.intro)}</p>
      <table class="lista"><tbody>${lista}</tbody></table>
      <div class="diagrama paisagem">${svgs[d.id]}</div></section>`;
  }).join('');

  const dicionario = DOMINIOS.map((d) => d.tabelas.map((n) => tabelaDicionario(porNome.get(n))).join('')).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Clean Air Tech - Esquema do banco de dados</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  @page paisagem { size: A4 landscape; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, sans-serif; font-size: 10.5pt; color: #0f172a; line-height: 1.45; }
  h1 { font-size: 26pt; margin: 0 0 4pt; } h2 { font-size: 15pt; margin: 0 0 4pt; color: #0c4a6e; } h3 { font-size: 12pt; color: #0c4a6e; margin: 14pt 0 4pt; } h4 { font-size: 10.5pt; margin: 12pt 0 2pt; font-family: Consolas, monospace; }
  .capa { page-break-after: always; padding-top: 60mm; } .capa .sub { font-size: 13pt; color: #475569; } .capa .meta { margin-top: 30mm; color: #475569; font-size: 10.5pt; }
  .cartoes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8pt; margin: 10pt 0 14pt; }
  .card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 8pt 10pt; background: #f8fafc; } .card b { display: block; font-size: 20pt; color: #0369a1; } .card span { color: #475569; font-size: 9.5pt; }
  .dominio { page-break-before: always; } .dominio .diagrama { page: paisagem; page-break-before: always; }
  .diagrama svg { width: 100%; height: auto; max-height: 185mm; }
  table { border-collapse: collapse; width: 100%; } .lista td { border-bottom: 1px solid #e2e8f0; padding: 3pt 6pt; vertical-align: top; } .lista td:first-child { width: 42mm; }
  .dic { font-size: 8pt; margin-bottom: 4pt; } .dic th { background: #e0f2fe; text-align: left; padding: 3pt 4pt; } .dic td { border-bottom: 1px solid #e2e8f0; padding: 2pt 4pt; vertical-align: top; }
  .mono { font-family: Consolas, "Courier New", monospace; font-size: 0.92em; } .desc { margin: 0 0 3pt; color: #475569; font-size: 9pt; }
  ul { margin: 4pt 0 8pt 16pt; padding: 0; } li { margin-bottom: 3pt; }
  .apendice, .pagina { page-break-before: always; } .visao { page: paisagem; page-break-before: always; }
</style></head><body>
<section class="capa"><h1>Clean Air Tech</h1><div class="sub">Modelo do banco de dados<br>PostgreSQL 17 + TimescaleDB · camadas raw, refined e trusted</div>
<div class="meta">Dispositivo de Monitoramento de Qualidade do Ar com Aplicativo de Aconselhamento<br>Engenharia de Software · UNICESUMAR Curitiba<br>
Daniel Fernando Abreu de Moraes · Gabriel Guedes Archanjo · Lorena Andrade de Souza · Vanusa da Silva Almeida<br><br>
Gerado a partir do banco real em ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</div></section>

<section><h2>Resumo</h2>
<p>O banco foi construído por migrations versionadas e validado de ponta a ponta: aplicar, desfazer e reaplicar todas as migrations, e uma bateria de testes automatizados sobre regras de integridade, segurança e carga de dados. Os números e diagramas deste documento foram lidos do próprio banco.</p>
<div class="cartoes">${cartoes}</div>
<h3>Princípios de projeto</h3><ul>
<li><b>Três camadas:</b> <i>raw</i> (dado bruto, retenção curta) → <i>refined</i> (modelo operacional em 3FN) → <i>trusted</i> (esquema estrela, sem dado pessoal).</li>
<li><b>Segurança em profundidade:</b> quatro papéis de banco com privilégio mínimo; Row Level Security isolando cada usuário; colunas sensíveis (hash de senha, segredo de MFA, tokens) invisíveis ao usuário final por GRANT; leituras dos sensores só pela view filtrada.</li>
<li><b>Auditoria imutável:</b> a trilha é somente-inserção e nunca grava segredos; telemetria do dispositivo não gera ruído na trilha.</li>
<li><b>Histórico correto (SCD Tipo 2):</b> firmware, versões dos modelos de IA e a dimensão de dispositivo guardam o passado; o rollback de um modelo de IA cria um novo período de vigência em vez de apagar.</li>
<li><b>Gestão de frota:</b> Device Shadow (estado desejado × reportado), grupos, feature flags com rollout percentual, lotes, certificações e garantias.</li>
<li><b>Identidade completa:</b> e-mail, telefone (E.164), login social (Apple por <i>sub</i>, nunca por e-mail), MFA, sessões e recuperação de senha com token de uso único.</li>
<li><b>Padrões internacionais:</b> TIMESTAMPTZ (ISO 8601), fuso IANA, idioma BCP 47, telefone E.164, UUID, unidade de medida no nome da coluna.</li></ul>
</section>

<section class="pagina"><h2>Ajustes e validação</h2>
<h3>Ajustes em relação ao Manual de Desenvolvimento (v1)</h3><ul>
<li><b>Fato horário:</b> a chave de tempo era apenas uma data, o que não sustenta granularidade horária; foi acrescentada <span class="mono">hora_do_dia</span> à chave.</li>
<li><b>Organização × ambiente:</b> a organização não se ligava a nenhum ambiente; <span class="mono">local.organizacao_id</span> fecha o modelo multi-organização.</li>
<li><b>Tipos de alerta:</b> ampliados de 5 para 10, cobrindo todas as grandezas medidas (PM10, NO₂, TVOC, UV e temperatura).</li>
<li><b>Titular do dispositivo:</b> o manual tratava <span class="mono">usuario_proprietario_id</span> como redundante e também como distinto de <span class="mono">local_membro</span>; a regra adotada é que ele seja proprietário do local (dono ou membro com nível proprietário), garantida por gatilho.</li>
<li><b>Leituras e RLS:</b> a hypertable comprimida não recebe RLS; a API lê pela view <span class="mono">v_leitura_sensor_usuario</span>.</li>
<li><b>Carga raw → refined:</b> usa <span class="mono">INSERT … ON CONFLICT DO NOTHING</span> (suportado em hypertable) no lugar de MERGE.</li></ul><h3>Como o banco foi validado</h3><ul>
<li><b>Migrations reversíveis:</b> as ${migracoes} migrations são aplicadas, desfeitas por completo e reaplicadas a cada validação.</li>
<li><b>${testes} testes automatizados</b> em PostgreSQL 17 real, cobrindo estrutura (convenções de nomes, comentários, índices em toda FK, ausência de dado pessoal na camada trusted), identidade e autenticação, frota, leituras, alertas, suporte, LGPD e a carga raw → refined → trusted.</li>
<li><b>Segurança testada com cenário de vários usuários:</b> dono, convidado, gestor e membro de organização e um usuário sem vínculo; falha fechada quando a sessão não informa o usuário; usuário não consegue se promover, alterar status da conta nem ler hash de senha, token ou segredo de MFA.</li>
<li><b>TimescaleDB:</b> hypertable, compressão e políticas de retenção são verificadas no CI com a imagem oficial do TimescaleDB.</li>
<li><b>Reprodutível:</b> <span class="mono">npm run db:validar</span> roda tudo sem Docker (PostgreSQL embutido); <span class="mono">npm run db:diagramas</span> regenera estes diagramas a partir do banco real.</li></ul></section>

<section class="visao"><h2>Visão geral das camadas e domínios</h2><div class="diagrama">${svgs.geral}</div></section>
${secoes}
<section class="apendice"><h2>Apêndice — Dicionário de dados</h2>${dicionario}</section>
</body></html>`;
}

// ---------------------------------------------------------------- execucao
const banco = await subirBanco({ porta: 54331 });
try {
  await migrar(banco.url, 'up');
  const c = new pg.Client({ connectionString: banco.url });
  c.on('error', () => {});
  await c.connect();
  let info;
  try {
    info = await introspectar(c);
  } finally {
    await c.end().catch(() => {});
  }

  const svgs = { geral: renderizar('00-visao-geral', mermaidVisaoGeral(info)) };
  DOMINIOS.forEach((d, i) => {
    svgs[d.id] = renderizar(`${String(i + 1).padStart(2, '0')}-${d.id}`, mermaidER(d, info));
  });

  const pastaTestes = path.join(raiz, 'database', 'tests');
  const testes = readdirSync(pastaTestes).filter((f) => f.endsWith('.test.mjs'))
    .reduce((s, f) => s + (readFileSync(path.join(pastaTestes, f), 'utf8').match(/^\s+it\(/gm) ?? []).length, 0);

  const html = montarHtml(info, svgs, testes);
  const arquivoHtml = path.join(saida, 'esquema-banco.html');
  writeFileSync(arquivoHtml, html, 'utf8');
  const arquivoPdf = path.join(saida, 'Esquema_Banco_Clean_Air_Tech.pdf');
  execFileSync(navegador, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', `--print-to-pdf=${arquivoPdf}`, pathToFileURL(arquivoHtml).href], { stdio: 'ignore' });
  console.log(`OK: ${info.tabelas.length} tabelas, ${DOMINIOS.length + 1} diagramas, PDF em database/docs/`);
} catch (erro) {
  console.error('FALHA:', erro);
  process.exitCode = 1;
} finally {
  await banco.parar();
}
