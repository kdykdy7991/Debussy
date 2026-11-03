// Disposable source-copy experiment. No production file, migration or composition is changed.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pi = resolve(here, '../..');
const server = join(pi, 'packages/server');
const src = join(server, 'src');
if (!process.env.PI_ORCHESTRATION_TEST_DATABASE_URL) throw new Error('Set PI_ORCHESTRATION_TEST_DATABASE_URL');
const scratch = await mkdtemp(join(tmpdir(), 'orchestration-decoupling-'));

function replaceOnce(text, before, after) {
 if (text.split(before).length !== 2) throw new Error(`Prototype patch needs review: ${before.slice(0, 100)}`);
 return text.replace(before, after);
}
function absoluteImports(text, original) {
 return text.replace(/(from\s+["'])(\.[^"']+)(["'])/g,
  (_match, prefix, path, suffix) => `${prefix}${resolve(dirname(original), path)}${suffix}`);
}
try {
 await symlink(join(pi, 'node_modules'), join(scratch, 'node_modules'), 'dir');
 const original = join(src, 'embed/conversations/service.ts');
 let service = await readFile(original, 'utf8');
 service = replaceOnce(service, 'private readonly repos: PublishingRepositories;',
  'private readonly resolveExecutionConfiguration;\n\tprivate readonly repos: PublishingRepositories;');
 service = replaceOnce(service, 'this.repos = options.repositories;',
  'this.resolveExecutionConfiguration = options.resolveExecutionConfiguration;\n\t\tthis.repos = options.repositories;');
 const first = service.indexOf('\t\t\tconst version = await this.repos.publishedAppVersions.get(scope, record.publishedAppVersionId);',
  service.indexOf('async executeTurn('));
 const last = service.indexOf('\t\t\tconst parsed = parseRuntimeSpec(version.runtimeSpec);', first);
 if (first < 0 || last < first) throw new Error('Execution boundary moved');
 service = service.slice(0, first) + `
   const turnId = input.turnId ?? newTurnId();
   const version = await this.resolveExecutionConfiguration(scope, record, turnId);
   if (version === undefined) return { ok: false, error: versionUnavailable() };
   const agentId = version.agentId;
` + service.slice(last);
 // Keep the rest of executeTurn identical, apart from source-aware scope/audit/reasoning.
 service = replaceOnce(service, '\t\t\tconst turnId = input.turnId ?? newTurnId();', '');
 service = replaceOnce(service,
  'const conversationReasoning = await this.repos.conversationReasoning.get(scope, input.conversationId);',
  'const conversationReasoning = version.source.kind === "chat" ? await this.repos.conversationReasoning.get(scope, input.conversationId) : undefined;');
 const executionStart = service.indexOf('async executeTurn(');
 const executionEnd = service.indexOf('\n\t/**', executionStart);
 let execution = service.slice(executionStart, executionEnd);
 execution = replaceOnce(execution, 'publishedAppVersionId: record.publishedAppVersionId,',
  'publishedAppVersionId: spec.publishedAppVersionId,\n\t\t\t\tintegrationId: scope.integrationId,\n\t\t\t\texecutionSource: version.source,');
 execution = replaceOnce(execution, 'agentRevisionId: version.sourceAgentRevision,',
  '...(version.sourceAgentRevision !== null ? { agentRevisionId: version.sourceAgentRevision } : {}),\n\t\t\t\t\texecutionSource: version.source,');
 service = service.slice(0, executionStart) + execution + service.slice(executionEnd);
 service = replaceOnce(service, 'function ownerScope(principal: EmbedAuthContext) {\n\treturn {',
  'function ownerScope(principal: EmbedAuthContext) {\n\treturn {\n\t\tintegrationId: principal.integrationId,');
 await writeFile(join(scratch, 'service.ts'), absoluteImports(service, original));

 // Source copies retain existing transactional sequence/counter/history algorithms.
 // This is deliberately NOT a complete production repository or type migration.
 for (const name of ['conversations', 'conversation-events', 'conversation-summaries']) {
  const path = join(src, 'persistence/postgres/repositories', `${name}.ts`);
  let text = await readFile(path, 'utf8');
  text = text.replaceAll('published_app_version_id', 'orchestration_version_id')
   .replaceAll('published_app_id', 'integration_id')
   .replaceAll('publishedAppVersionId', 'orchestrationVersionId')
   .replaceAll('publishedAppId', 'integrationId');
  if (name === 'conversation-events') {
   text = replaceOnce(text, '(id, tenant_id, integration_id, conversation_id, sequence, event_type,',
    '(source, owner_principal_id, id, tenant_id, integration_id, conversation_id, sequence, event_type,');
   text = replaceOnce(text, 'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())',
    "values ('orchestration', (select owner_principal_id from conversations where id=$4), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())");
  }
  if (name === 'conversation-summaries') {
   text = replaceOnce(text, '(id, tenant_id, integration_id, owner_principal_id, conversation_id,',
    '(source, id, tenant_id, integration_id, owner_principal_id, conversation_id,');
   text = replaceOnce(text, 'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
    "values ('orchestration', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)");
  }
  await writeFile(join(scratch, `${name}.ts`), absoluteImports(text, path));
 }
 const test = (await readFile(join(here, 'proof.test.ts.template'), 'utf8'))
  .replaceAll('@SOURCE@', src).replaceAll('@EXPERIMENT@', here);
 await writeFile(join(scratch, 'proof.test.ts'), test);
 const result = spawnSync(process.execPath, [join(pi, 'node_modules/vitest/dist/cli.js'), '--run',
  '--config', join(server, 'vitest.config.ts'), '--root', scratch, 'proof.test.ts'],
  { cwd: server, stdio: 'inherit', env: process.env });
 process.exitCode = result.status ?? 1;
} finally {
 await rm(scratch, { recursive: true, force: true });
}
