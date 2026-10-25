export interface ProviderPolicy {
  providerKey: string;
  enabled: boolean;
  headerFrom: readonly string[];
  dkimDomains: readonly string[];
  loginSubject: RegExp;
  loginBody: RegExp;
  reject: RegExp;
  codeLengths: readonly number[];
  minimumConfidence: number;
  maxCodeAgeSeconds: number;
  maxMessages: number;
}

export const DENIED_PURPOSE = /reset|recover|password|change|billing|invoice|payment|cancel|refund|purchase|order|recovery|kh[oô]i ph[uụ]c|m[aậ]t kh[aẩ]u|パスワード|復旧|支払|密码|重置|恢复|付款/i;

// No sender addresses are guessed. Activation requires reviewed legitimate samples.
const PROVIDERS: Readonly<Record<string, ProviderPolicy>> = Object.freeze({
  muse: Object.freeze({
    providerKey: "muse", enabled: false, headerFrom: [], dkimDomains: [],
    loginSubject: /(?!) /, loginBody: /(?!) /, reject: DENIED_PURPOSE,
    codeLengths: [6], minimumConfidence: 1, maxCodeAgeSeconds: 120, maxMessages: 20,
  }),
});

export function providerPolicy(key: string): ProviderPolicy | null {
  const policy = Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? PROVIDERS[key] : null;
  return policy?.enabled && policy.headerFrom.length && policy.dkimDomains.length ? policy : null;
}
