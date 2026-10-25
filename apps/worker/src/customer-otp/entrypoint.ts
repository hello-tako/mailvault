import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../env";
import { authorizeRpc } from "./auth";
import type { AliasValidation, LoginOtpResult } from "./contracts";
import { lookupLoginOtp, validateAlias } from "./lookup";
import { providerPolicy } from "./providers";

export class CustomerOtpReader extends WorkerEntrypoint<Env> {
  async validateAlias(input: unknown): Promise<AliasValidation> {
    try {
      const request = await authorizeRpc(this.env, input, "validateAlias");
      if (!request) return { state: "routing_unknown", aliasId: "" };
      return await validateAlias(this.env, request, providerPolicy(request.providerKey));
    } catch { return { state: "routing_unknown", aliasId: "" }; }
  }

  async lookupLoginOtp(input: unknown): Promise<LoginOtpResult> {
    try {
      const request = await authorizeRpc(this.env, input, "lookupLoginOtp");
      if (!request) return { state: "unavailable" };
      return await lookupLoginOtp(this.env, request, providerPolicy(request.providerKey));
    } catch { return { state: "unavailable" }; }
  }
}
