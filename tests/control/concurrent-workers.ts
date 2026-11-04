import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
/** Independent processes cannot share a JS event loop; these workers contend on the same SQLite writer lock. */
export async function concurrentCommands(filename: string, calls: {
    method: string;
    input: unknown;
}[]): Promise<({
    ok: true;
    value: any;
} | {
    ok: false;
    code: string;
    message: string;
})[]> {
    const gate = new SharedArrayBuffer(4);
    const source = `
  const {parentPort,workerData}=require('node:worker_threads');
  const fs=require('node:fs');const ts=require('typescript');
  require.extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,filename);
  const Database=require('better-sqlite3');
  const {SqliteControlStore}=require(workerData.storeFile);
  const db=new Database(workerData.filename);db.pragma('journal_mode=WAL');
  const store=new SqliteControlStore(db);
  parentPort.postMessage({ready:true});
  Atomics.wait(new Int32Array(workerData.gate),0,0);
  store[workerData.call.method](workerData.call.input).then(value=>{db.close();parentPort.postMessage({ok:true,value});},error=>{db.close();parentPort.postMessage({ok:false,code:error.code,message:error.message});});
 `;
    const handles = calls.map(call => {
        const worker = new Worker(source, { eval: true, workerData: { filename, call, gate, storeFile: resolve("src/adapters/control/sqlite-control-store.ts") } });
        let readyResolve: () => void;
        const ready = new Promise<void>(r => readyResolve = r);
        const result = new Promise<any>((resolve, reject) => {
            worker.on("message", message => message.ready ? readyResolve() : resolve(message));
            worker.on("error", reject);
            worker.on("exit", code => {
                if (code)
                    reject(new Error(`Worker exited ${code}`));
            });
        });
        return { worker, ready, result };
    });
    try {
        await Promise.all(handles.map(h => h.ready));
        Atomics.store(new Int32Array(gate), 0, 1);
        Atomics.notify(new Int32Array(gate), 0);
        return await Promise.all(handles.map(h => h.result));
    }
    finally {
        await Promise.all(handles.map(h => h.worker.terminate()));
    }
}
