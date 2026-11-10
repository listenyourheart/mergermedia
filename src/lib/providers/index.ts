// سجل المحوّلات — يربط معرف المزود بمحوّله
import type { ProviderAdapter } from "./types";
import { kieAdapter } from "./kie";
import { cometApiAdapter } from "./cometapi";

export const ADAPTERS: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometApiAdapter,
};
