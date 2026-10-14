/**
 * Condense a REA `analyze-javascript-application` Evidence JSON into a small, reviewable digest.
 *
 * The raw bundles are tens of megabytes and are deliberately not committed; this keeps the facts a
 * reader actually needs (modules, endpoints, storage keys, exported functions, human-readable string
 * literals) and drops the per-expression plumbing. Usage:
 *
 *   node digest.mjs <evidence.json> <source-repo> > evidence/<name>.json
 */
import { readFileSync } from 'node:fs';

const [, , file, repo] = process.argv;
if (!file || !repo) {
  console.error('usage: node digest.mjs <evidence.json> <source-repo>');
  process.exit(2);
}

const evidence = JSON.parse(readFileSync(file, 'utf8'));
const result = evidence.normalized_result;
const idOf = (node) =>
  String(
    (node.identity &&
      (node.identity.path ||
        node.identity.key ||
        node.identity.value ||
        node.identity.name ||
        node.identity.role_key)) ??
      node.label ??
      '',
  );

const basenameOf = (value) => String(value).split('\\').join('/').split('/').pop() ?? value;

const nodes = result.graph.nodes;
const modules = nodes
  .filter((n) => n.kind === 'javascript-module')
  .map(idOf)
  .filter(
    (v) =>
      !v.startsWith('external:') && !v.startsWith('static-import:') && !v.startsWith('not-found:'),
  )
  .map((v) => {
    // Module ids are either "<sha>:path" or a JSON tuple; keep the path only.
    const tuple = v.match(/\[.*?,"([^"]+)"\]$/);
    if (tuple) return tuple[1];
    const colon = v.indexOf(':');
    return colon === -1 ? v : v.slice(colon + 1);
  })
  .filter((v) => /\.[cm]?[jt]sx?$/.test(v));

const endpoints = nodes
  .filter((n) => n.kind === 'endpoint')
  .map(idOf)
  .filter((v) => v.startsWith('/'));
const storage = nodes
  .filter((n) => n.kind === 'storage')
  .map(idOf)
  .filter((v) => !v.startsWith('call:'))
  .filter((v, i, all) => all.indexOf(v) === i);

const semantic = result.semantic_graph?.nodes ?? [];
const functions = semantic
  .filter((n) => n.kind === 'function')
  .map((n) => ({ module: n.identity?.module_path ?? '', name: n.label ?? '' }))
  .filter((f) => f.name);

const stringLiterals = semantic
  .filter((n) => n.kind === 'literal' && typeof n.properties?.value === 'string')
  .map((n) => n.properties.value)
  .filter((v) => v.length >= 3 && v.length <= 80 && /[A-Za-z\u4e00-\u9fff]/.test(v))
  .filter((v) => !/^#[0-9a-f]{3,8}$/i.test(v))
  .filter((v, i, all) => all.indexOf(v) === i);

const tasks = semantic.filter((n) => n.kind === 'task').map(idOf);

const uniqueSorted = (list) => [...new Set(list)].sort();

console.log(
  JSON.stringify(
    {
      source_repo: repo,
      analyzed_path: result.input_path,
      analyzer: `${evidence.provider?.name ?? 'rea'} ${evidence.operation ?? ''}`.trim(),
      evidence_id: evidence.evidence_id,
      limitations: result.limitations ?? evidence.limitations ?? null,
      counts: {
        modules: uniqueSorted(modules).length,
        endpoints: endpoints.length,
        storage_keys: storage.length,
        functions: functions.length,
        string_literals: stringLiterals.length,
      },
      endpoints: uniqueSorted(endpoints),
      storage_keys: storage,
      modules: uniqueSorted(modules),
      functions: uniqueSorted(functions.map((f) => `${f.module} :: ${f.name}`)),
      string_literals: stringLiterals,
      tasks,
    },
    null,
    1,
  ),
);
