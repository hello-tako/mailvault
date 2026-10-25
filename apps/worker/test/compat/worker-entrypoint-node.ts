// Node regression tests import the default handler through index.ts. Native RPC
// semantics are tested separately in workerd; this shim only permits that import.
export class WorkerEntrypoint<Env> {
  constructor(protected ctx: unknown, protected env: Env) {}
}
