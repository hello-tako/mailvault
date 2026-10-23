// Test-only Worker. It calls the installed mailauth package, with the pnpm patch applied,
// inside workerd, so the compatibility claim covers the real dependency rather than a copy.
// The policy is fixed here: strict parsing, and RSA-SHA1 is refused with a `policy` result.
import { dkimVerify } from "mailauth/lib/dkim/verify";

interface VerifyRequest {
  message: string;
  dns: Record<string, string[][]>;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") return Response.json({ ready: true });

    const { message, dns } = (await request.json()) as VerifyRequest;
    const resolver = async (name: string, type: string) => {
      const record = dns[name];
      if (type === "TXT" && record) return record;
      throw Object.assign(new Error(`no ${type} record for ${name}`), { code: "ENOTFOUND" });
    };

    const verified = await dkimVerify(message, { strict: true, rejectRsaSha1: true, resolver });
    return Response.json({
      results: verified.results.map((r) => ({
        result: r.status.result,
        comment: r.status.comment ?? null,
        algorithm: r.algo ?? null,
      })),
    });
  },
};
