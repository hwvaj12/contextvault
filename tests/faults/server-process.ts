import { createApp } from '../../src/app';
import { loadConfiguration } from '../../src/config';
import type { Operation } from '../../src/domain';

const stages: Record<string, string> = { 'before-candidate': 'before-prepare', 'after-candidate': 'after-prepare', 'before-acceptance': 'before-accept', 'after-acceptance': 'after-accept' };
async function main() {
  let armed: string | null = null;
  const clock = process.env.CV_FAULT_CLOCK!;
  if (!Number.isFinite(Date.parse(clock)) || !process.send) throw Error('Physical fixture requires its private clock and IPC channel');
  const send = (value: unknown) => process.send!(value);
  const app = await createApp({ logger: false, contextVault: { configuration: loadConfiguration(), maintenance: false, now: () => clock,
    lifecycle: { processingRenewIntervalMs: 0, hook: async (stage, operation: Operation) => {
      if (operation.kind !== 'finalize' || !armed || stage !== stages[armed]) return;
      const boundary = armed; armed = null;
      const identity = operation.intent.candidateIdentity!;
      const binding = await app.contextVault.control.getBinding(operation.scope, identity.scope.storageBindingId);
      if (!binding) throw Error('Physical fixture lost the persisted binding');
      const candidate = await (await app.contextVault.revisionStore(binding)).inspectCandidate(identity);
      send({ type: 'boundary', boundary, pid: process.pid, operationId: operation.id, candidatePresent: candidate !== null });
      await new Promise(() => {});
    } },
  } });
  const submissions = app.contextVault.lifecycle.runtime.dependencies.submissions;
  const write = submissions.writeFile.bind(submissions);
  submissions.writeFile = async input => {
    if (armed !== 'during-transfer' || input.path !== 'binary.bin') return write(input);
    armed = null; let consumed = 0;
    async function* observedBytes() {
      for await (const chunk of input.bytes) {
        yield chunk;
        // The adapter requests the next chunk only after processing this one.
        consumed += chunk.byteLength;
        if (consumed >= 6 * 1024 * 1024) {
          const rows = app.contextVault.database.prepare("SELECT id FROM catalog_records WHERE kind='submission-writer' AND customer_id=? AND workspace_id=? AND run_id=? AND json_extract(data,'$.submissionId')=? AND json_extract(data,'$.state')='active'")
            .all(input.scope.customerId, input.scope.workspaceId, input.scope.runId, input.submissionId) as { id: string }[];
          send({ type: 'boundary', boundary: 'during-transfer', pid: process.pid, receivedByteLength: consumed,
            adapterProgress: { consumedByteLength: consumed, writerIds: rows.map(row => row.id) } });
          await new Promise(() => {});
        }
      }
    }
    return write({ ...input, bytes: observedBytes() });
  };
  process.on('message', async (message: any) => {
    try {
      if (message.command === 'arm') {
        if (armed || ![...Object.keys(stages), 'during-transfer'].includes(message.boundary)) throw Error('Invalid physical boundary');
        armed = message.boundary; send({ id: message.id, ok: true });
      } else if (message.command === 'recover') send({ id: message.id, ok: true, report: await app.contextVault.maintenance.runOnce() });
      else throw Error('Unknown physical fixture command');
    } catch (error) { send({ id: message.id, ok: false, code: (error as any).code ?? 'PHYSICAL_FIXTURE_FAILED' }); }
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  send({ type: 'ready', pid: process.pid, baseUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` });
}
main().catch(() => { process.stderr.write('Physical server fixture failed\n'); process.exitCode = 1; });
