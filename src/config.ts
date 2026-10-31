// Env-based config. No config file in v0.1. API keys are read from the
// environment only and are never logged or written to session files.

export type ProviderName = 'mock' | 'deepseek' | 'custom';

export interface Config {
  provider: ProviderName;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
  workspace: string;
  maxSteps: number;
  dryRun: boolean;
}

export interface CliOverrides {
  provider?: string;
  model?: string;
  workspace?: string;
  maxSteps?: number;
  dryRun?: boolean;
}

function defaultModel(provider: ProviderName, envModel: string | undefined): string {
  if (envModel) return envModel;
  if (provider === 'deepseek') return 'deepseek-chat';
  if (provider === 'mock') return 'mock';
  throw new Error('custom provider needs a model: set --model or MOLA_MODEL');
}

function defaultBaseUrl(provider: ProviderName, envBase: string | undefined): string | null {
  if (envBase) return envBase;
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1';
  return null;
}

export function loadConfig(overrides: CliOverrides): Config {
  const providerRaw = overrides.provider ?? process.env.MOLA_PROVIDER ?? 'mock';
  if (providerRaw !== 'mock' && providerRaw !== 'deepseek' && providerRaw !== 'custom') {
    throw new Error(`unknown provider: ${providerRaw} (expected mock, deepseek, or custom)`);
  }
  const provider = providerRaw as ProviderName;
  const apiKey = process.env.MOLA_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? null;
  if (provider !== 'mock' && !apiKey) {
    throw new Error(
      `provider ${provider} needs an API key: set MOLA_API_KEY ` +
        (provider === 'deepseek' ? '(or DEEPSEEK_API_KEY)' : '') +
        ' in the environment',
    );
  }
  const baseUrl = defaultBaseUrl(provider, process.env.MOLA_BASE_URL);
  if (provider === 'custom' && !baseUrl) {
    throw new Error('custom provider needs a base URL: set MOLA_BASE_URL');
  }
  const maxStepsRaw = overrides.maxSteps ?? Number(process.env.MOLA_MAX_STEPS ?? 10);
  const maxSteps = Number.isFinite(maxStepsRaw) && maxStepsRaw > 0 ? Math.floor(maxStepsRaw) : 10;
  return {
    provider,
    model: overrides.model ?? defaultModel(provider, process.env.MOLA_MODEL),
    apiKey,
    baseUrl,
    workspace: overrides.workspace ?? process.env.MOLA_WORKSPACE ?? process.cwd(),
    maxSteps,
    dryRun: overrides.dryRun ?? false,
  };
}
