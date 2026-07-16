export type CommandEveLocalPull = Readonly<{
  model: string;
  percent: number;
  status: string;
}>;

export type CommandEveLocalTierModelRefs = Readonly<{
  runtime_model_ref?: string;
  model_ref?: string;
}>;

export function commandEveLocalPullMatchesTier(
  pull: CommandEveLocalPull | null,
  tier: CommandEveLocalTierModelRefs | undefined
): boolean {
  if (!pull || !tier) return false;
  return pull.model === tier.runtime_model_ref || pull.model === tier.model_ref;
}
