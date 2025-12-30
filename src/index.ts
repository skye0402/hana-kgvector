import { loadEnv } from "./env";

loadEnv();

export type HanaKGVectorConfig = {
  hana?: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    schema?: string;
  };
  litellm?: {
    baseUrl?: string;
    apiKey?: string;
  };
};

export function getConfigFromEnv(): HanaKGVectorConfig {
  return {
    hana: {
      host: process.env.HANA_HOST,
      port: process.env.HANA_PORT ? Number(process.env.HANA_PORT) : undefined,
      user: process.env.HANA_USER,
      password: process.env.HANA_PASSWORD,
      schema: process.env.HANA_SCHEMA
    },
    litellm: {
      baseUrl: process.env.LITELLM_PROXY_URL,
      apiKey: process.env.LITELLM_API_KEY
    }
  };
}
