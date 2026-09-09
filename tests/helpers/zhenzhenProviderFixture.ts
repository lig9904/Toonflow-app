import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import { transform } from "sucrase";
import { VM } from "vm2";
import FormData from "form-data";
import * as nodeCrypto from "node:crypto";

export type MockCall = {
  kind: "fetch" | "axios";
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

export type ZhenzhenFixture = {
  provider: Record<string, any>;
  calls: MockCall[];
  setHandler: (handler: (call: MockCall) => Response | Promise<Response>) => void;
  resetCalls: () => void;
};
export interface ZhenzhenFixtureOptions { fastTimeout?: boolean }

const providerPath = path.resolve(process.cwd(), "providers/zhenzhen.ts");

export async function zhenzhenProviderAvailable(): Promise<boolean> {
  try {
    await access(providerPath);
    return true;
  } catch {
    return false;
  }
}

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function loadZhenzhenProvider(options: ZhenzhenFixtureOptions = {}): Promise<ZhenzhenFixture> {
  if (!(await zhenzhenProviderAvailable())) throw new Error(`missing provider: ${providerPath}`);
  const source = await readFile(providerPath, "utf8");
  const javascript = transform(source, { transforms: ["typescript"] }).code.replace(/export\s*\{\s*\};?/g, "");
  const exports: Record<string, any> = {};
  const calls: MockCall[] = [];
  let handler: (call: MockCall) => Response | Promise<Response> = () => response({});

  const call = async (kind: MockCall["kind"], input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body instanceof FormData ? init.body : typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const item = { kind, url: String(input), method: init.method ?? "GET", headers, body } satisfies MockCall;
    calls.push(item);
    return handler(item);
  };

  const axiosCall = async (url: string, method: string, body?: unknown, config?: RequestInit) => {
    const response = await call("axios", url, {
      ...config,
      method,
      body: (body instanceof FormData ? body : typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body)) as any,
    });
    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
    const result = { data, status: response.status, headers: Object.fromEntries(response.headers.entries()) };
    if (!response.ok) {
      const error = Object.assign(new Error(typeof data === "string" ? data : JSON.stringify(data)), { response: result });
      throw error;
    }
    return result;
  };

  const axios = {
    get: (url: string, config?: RequestInit) => axiosCall(url, "GET", undefined, config),
    post: (url: string, body?: unknown, config?: RequestInit) => axiosCall(url, "POST", body, config),
    request: (config: RequestInit & { url: string; data?: unknown }) => axiosCall(config.url, config.method ?? "GET", config.data, config),
    create: () => axios,
  };

  const vm = new VM({
    timeout: 0,
    eval: false,
    wasm: false,
    sandbox: {
      exports,
      logger: () => undefined,
      fetch: (input: string | URL | Request, init?: RequestInit) => call("fetch", String(input), init),
      axios,
      FormData,
      crypto: nodeCrypto,
      AbortController,
      setTimeout: options.fastTimeout
        ? ((handler: (...args: any[]) => void) => {
            queueMicrotask(handler);
            return 0;
          })
        : setTimeout,
      clearTimeout,
      URL,
      Headers,
      Response,
      pollTask: async (fn: () => Promise<{ completed: boolean; data?: string; error?: string }>) => fn(),
      createOpenAICompatible: (config: unknown) => ({ kind: "openai-compatible", config, chatModel: (model: string) => ({ kind: "openai-compatible", config, model }) }),
      urlToBase64: async (url: string) => url,
    },
  });
  vm.run(javascript);
  exports.vendor.inputValues.baseUrl = "https://api.seedance.nz";
  exports.vendor.inputValues.apiKey = "zhenzhen-local-test-key";

  return {
    provider: exports,
    calls,
    setHandler(next) {
      handler = next;
    },
    resetCalls() {
      calls.length = 0;
    },
  };
}

export { response };
