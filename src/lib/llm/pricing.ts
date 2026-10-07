/**
 * List prices of the models the cost estimate knows, in USD per million
 * tokens (https://platform.claude.com/docs/en/about-claude/pricing). Models
 * not listed get a token estimate only.
 */
export interface ModelPrice {
  input: number;
  output: number;
  /** Prompts above this many tokens are billed at the `long*` rates. */
  longPromptThreshold?: number;
  longInput?: number;
  longOutput?: number;
  /** Multiplier for prompt tokens read from the cache. */
  cacheRead: number;
}

const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longPromptThreshold: 100_000, longInput: 0.5, longOutput: 2.5, cacheRead: 0.1 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
};

export function modelPrice(model: string): ModelPrice | null {
  return PRICES[model] ?? null;
}

/** Cost of one request in USD; `cachedInput` of the input tokens are cache reads. */
export function requestCost(price: ModelPrice, input: number, output: number, cachedInput = 0): number {
  const long = price.longPromptThreshold !== undefined && input > price.longPromptThreshold;
  const inRate = long ? (price.longInput ?? price.input) : price.input;
  const outRate = long ? (price.longOutput ?? price.output) : price.output;
  const fresh = input - cachedInput;
  return (fresh * inRate + cachedInput * inRate * price.cacheRead + output * outRate) / 1_000_000;
}
